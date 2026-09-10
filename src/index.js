/**
 * A Chrome tab, driven from a script.
 *
 * The whole of it is Node's own `WebSocket` and `fetch` against a browser started with
 * `--remote-debugging-port`. No dependency, because the protocol is a JSON envelope over a
 * socket and a library to send one is a library to maintain.
 *
 * Written because it had been written eleven times. Every copy did the same five things and
 * every copy was missing one of them, usually the cache one below.
 *
 * **On running code in the page.** `tab.eval` sends a string to Chrome's `Runtime.evaluate`,
 * which is what this tool is for: there is no way to ask a page what it looks like without
 * running something in it. It is not JavaScript's `eval`, and nothing here evaluates in this
 * process. The strings come from two places and no others: the expressions built in
 * `pure.js`, and whatever the operator typed on their own command line. There is no path
 * from page content back into an expression, so a hostile page cannot influence what is run
 * in it.
 *
 * What that does mean is that **a `pane` session is as privileged as the browser it attaches
 * to.** Attach it to a throwaway profile, never to the browser holding your logged-in
 * sessions, which is why the error below suggests `--user-data-dir=/tmp/pane-profile` rather
 * than leaving the flag out.
 */
import {
  clickExpression,
  clipFor,
  findFrame,
  flattenFrames,
  formatMessage,
  pickContext,
  typeExpression,
  waitExpression,
} from "./pure.js";

/**
 * Attach to a browser and open a tab.
 *
 * @param {{port?: number, url?: string, console?: boolean}} options
 */
export async function open({ port = 9222, url = "about:blank", console: collectConsole = false } = {}) {
  const target = await newTarget(port, url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`could not open a socket to the tab on port ${port}`));
  });

  let nextId = 0;
  const waiting = new Map();
  const messages = [];
  const contexts = [];

  ws.onmessage = (m) => {
    const x = JSON.parse(m.data);
    if (waiting.has(x.id)) {
      waiting.get(x.id)(x);
      waiting.delete(x.id);
      return;
    }
    if (x.method === "Runtime.executionContextCreated") contexts.push(x.params.context);
    if (x.method === "Runtime.executionContextsCleared") contexts.length = 0;
    const line = formatMessage(x.method, x.params ?? {});
    if (line !== null) messages.push(line);
  };

  /** One protocol command. Rejects on the protocol's own error rather than resolving it. */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, (x) => {
        // A protocol error arrives as a successful message with an `error` member, so
        // ignoring it means every failure looks like an empty result.
        if (x.error) reject(new Error(`${method}: ${x.error.message ?? JSON.stringify(x.error)}`));
        else resolve(x.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  if (collectConsole) await send("Log.enable");

  /**
   * Caching off, always.
   *
   * This is the line that was missing from most of the copies, and it cost the same hour
   * three separate times: a fix is made, the page is re-shot, the old asset is served from
   * cache, and the conclusion is that the fix did not work. Nothing about the screenshot
   * says it is stale.
   */
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  const tab = {
    send,
    messages,
    contexts,

    /** Everything the page printed, and every exception it threw. */
    log: () => [...messages],

    async viewport({ width = 1280, height = 900, scale = 2 } = {}) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      });
    },

    /**
     * Navigate, and wait until the page is genuinely ready to photograph.
     *
     * `document.fonts.ready` is the part people leave out. Without it the first screenshot
     * catches the fallback face, so the type looks wrong in the image and right in the
     * browser, and the difference is blamed on the CSS.
     */
    async go(url) {
      await send("Page.navigate", { url });
      await tab.eval(`new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))`);
      await tab.eval(`document.fonts.ready`);
    },

    /** Every frame in the page, with its URL. The tree is the only place a URL exists. */
    async frames() {
      const { frameTree } = await send("Page.getFrameTree");
      return flattenFrames(frameTree);
    },

    /**
     * Evaluate in the page, or in one frame of it.
     *
     * `frame` is matched against frame URLs and names, which needs the frame tree: an
     * execution context carries a `frameId` and no URL at all. A hint that matches nothing
     * throws rather than falling back to the outer page, because evaluating somewhere else
     * and returning a plausible answer is how the wrong frame gets photographed.
     */
    async eval(expression, { frame = null } = {}) {
      let contextId;
      if (frame !== null) {
        const found = findFrame(await tab.frames(), frame);
        if (!found) throw new Error(`no frame whose URL or name contains "${frame}"`);
        const context = pickContext(contexts, found.id);
        if (!context) throw new Error(`frame "${found.url}" has no execution context yet`);
        contextId = context.id;
      }

      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId ? { contextId } : {}),
      });
      if (result.exceptionDetails) throw pageError(result.exceptionDetails);
      return result.result?.value;
    },

    wait: (predicate, timeoutMs = 30_000) => tab.eval(waitExpression(predicate, timeoutMs)),
    type: (selector, value) => tab.eval(typeExpression(selector, value)),
    click: (text) => tab.eval(clickExpression(text)),
    settle: (ms = 500) => tab.eval(`new Promise((r) => setTimeout(r, ${ms}))`),

    /**
     * A PNG of the page, or of one element.
     *
     * The element's rectangle is read in document coordinates and clamped, because Chrome
     * answers a clip with negative coordinates by returning a blank image rather than an
     * error, which reads as a page that did not render.
     */
    async shot({ selector = null, pad = 20, fullPage = true } = {}) {
      let clip;
      if (selector) {
        const measured = await tab.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error("nothing matches " + ${JSON.stringify(selector)});
          const b = el.getBoundingClientRect();
          return {
            rect: { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height },
            page: {
              width: document.documentElement.scrollWidth,
              height: document.documentElement.scrollHeight,
            },
          };
        })()`);
        clip = clipFor(measured.rect, pad, measured.page);
      }

      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: fullPage,
        ...(clip ? { clip } : {}),
      });
      return Buffer.from(data, "base64");
    },

    close: () => ws.close(),
  };

  return tab;
}

/**
 * An error thrown inside the page, as one readable line.
 *
 * The protocol hands back a `description` that is the message followed by the page's own
 * stack, and printing all of it puts `at <anonymous>:12:11` on a terminal where it means
 * nothing: the line numbers are of an expression this tool built, not of any file the reader
 * can open. The first line is the part that says what went wrong.
 */
function pageError(details) {
  const full = details.exception?.description ?? details.text ?? "evaluation threw";
  const first = String(full).split("\n")[0].trim();
  const e = new Error(first);
  // Kept, because a library caller stepping through a driver script does want the rest.
  e.pageStack = full;
  return e;
}

/** A fresh tab on a running browser, with a message that says what to do when there is none. */
async function newTarget(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  let res;
  try {
    res = await fetch(endpoint, { method: "PUT" });
  } catch {
    // The most common failure by a wide margin, and the one worth spelling out: there is no
    // browser listening. Every copy of this printed a bare ECONNREFUSED and left you to
    // remember the flag.
    throw new Error(
      `no browser on port ${port}. Start one with:\n` +
        `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n` +
        `    --remote-debugging-port=${port} --user-data-dir=/tmp/pane-profile`,
    );
  }
  if (!res.ok) throw new Error(`the browser refused a new tab: ${res.status} ${res.statusText}`);
  const target = await res.json();
  if (!target.webSocketDebuggerUrl) throw new Error("the browser opened a tab with no debugger URL");
  return target;
}

export {
  clickExpression,
  clipFor,
  findFrame,
  flattenFrames,
  formatMessage,
  pickContext,
  typeExpression,
  waitExpression,
} from "./pure.js";
