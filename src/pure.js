/**
 * The decisions, separated from the socket.
 *
 * Everything in here is a pure function, which is the only reason any of this is tested: a
 * driver that talks to a browser is otherwise testable exclusively by having a browser, and
 * the parts that were actually wrong in eleven hand-written copies of this were never the
 * socket. They were the clip arithmetic, the argument parsing, and picking the wrong frame.
 */

/**
 * Command-line arguments, parsed.
 *
 * @returns {{ok: true, opts: object} | {ok: false, reason: string}}
 */
export function parseArgs(argv) {
  const opts = {
    url: null,
    out: null,
    width: 1280,
    height: 900,
    scale: 2,
    port: 9222,
    selector: null,
    pad: 20,
    settle: 600,
    evaluate: null,
    driver: null,
    frame: null,
    console: false,
    fullPage: true,
  };

  /**
   * Two kinds of number, because zero means something for two of them.
   *
   * `--pad 0` is "clip to the element exactly" and `--settle 0` is "do not wait", both of
   * which are things people ask for. A width of zero is not, and neither is a port.
   */
  const positive = new Set(["width", "height", "scale", "port"]);
  const nonNegative = new Set(["pad", "settle"]);
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const name = a.slice(2);
    if (name === "console") {
      opts.console = true;
      continue;
    }
    if (name === "no-full-page") {
      opts.fullPage = false;
      continue;
    }
    if (!(name in opts)) return { ok: false, reason: `unknown option --${name}` };

    const value = argv[++i];
    // A flag with no value is a typo, and treating the next flag as its value produces a
    // width of NaN and a screenshot nobody can explain.
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, reason: `--${name} needs a value` };
    }
    if (positive.has(name) || nonNegative.has(name)) {
      const n = Number(value);
      const floor = positive.has(name) ? 1 : 0;
      if (!Number.isFinite(n) || n < floor) {
        return {
          ok: false,
          reason: `--${name} must be ${floor === 1 ? "a positive number" : "zero or more"}, got "${value}"`,
        };
      }
      opts[name] = n;
    } else {
      opts[name] = value;
    }
  }

  opts.url = rest[0] ?? null;
  opts.out = rest[1] ?? opts.out;

  if (!opts.url) return { ok: false, reason: "give a URL" };
  // A relative path here is almost always a file that was meant to be a file:// URL, and
  // navigating to it silently resolves against about:blank and shows nothing.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(opts.url)) {
    return { ok: false, reason: `"${opts.url}" has no scheme. Use http://, https:// or file://` };
  }
  if (opts.selector && opts.pad < 0) return { ok: false, reason: "--pad cannot be negative" };

  return { ok: true, opts };
}

/**
 * The screenshot region for an element, clamped to the page.
 *
 * Clamped at the origin because an element near the top-left with padding applied produces
 * negative coordinates, and Chrome answers a negative clip with a blank image rather than
 * an error. That was the single most common failure across the copies of this: a screenshot
 * that came back empty and looked like the page had not rendered.
 *
 * @param {{x: number, y: number, width: number, height: number}} rect  document coordinates
 * @param {number} pad
 * @param {{width: number, height: number}} page  the full scrollable size
 */
export function clipFor(rect, pad, page) {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  // The requested width would run past the right edge once the origin has been clamped, so
  // the padding that was clipped off the left is not added back on the right.
  const width = Math.min(rect.width + pad * 2 - (x === 0 ? Math.max(0, pad - rect.x) : 0), page.width - x);
  const height = Math.min(rect.height + pad * 2 - (y === 0 ? Math.max(0, pad - rect.y) : 0), page.height - y);
  return {
    x,
    y,
    // A zero-height clip is a blank PNG. One pixel is not useful either, but it is visibly
    // wrong rather than invisibly wrong.
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    scale: 1,
  };
}

/**
 * Every frame in a `Page.getFrameTree` response, flattened.
 *
 * The tree is the only place a frame's URL exists. An execution context carries a `frameId`
 * and nothing else useful: no URL, no name. That is the fact that makes this function
 * necessary, and it was found by dumping the contexts of a page with fifteen iframes and
 * seeing `{isDefault, type, frameId}` and nothing more.
 */
export function flattenFrames(frameTree) {
  const out = [];
  const walk = (node) => {
    if (!node?.frame) return;
    out.push({ id: node.frame.id, url: node.frame.url ?? "", name: node.frame.name ?? "" });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return out;
}

/**
 * The frame whose URL or name contains a hint.
 *
 * @returns {{id: string, url: string, name: string} | null}
 */
export function findFrame(frames, hint) {
  if (!hint) return frames[0] ?? null;
  return (
    frames.find((f) => f.url.includes(hint)) ??
    frames.find((f) => f.name === hint) ??
    frames.find((f) => f.name.includes(hint)) ??
    null
  );
}

/**
 * Which execution context belongs to a frame.
 *
 * An isolated context is never returned. It has its own globals and none of the page's, so
 * an expression that reads the DOM comes back undefined there and reads as an empty page.
 *
 * The first version of this guessed the frame instead: it took the one that was *not* the
 * frame owning the isolated context. That works in Electron, where there is one preload and
 * one iframe, and it is wrong everywhere else. In plain Chrome there is no isolated context
 * at all, so the guess fell through to the earliest context and `--frame` silently returned
 * the outer page. Silently is the problem: it looked like the frame simply had no such
 * element.
 *
 * @param {{id: number, auxData?: object, name?: string}[]} contexts
 * @param {string | null} frameId  from `findFrame`, or null for whichever is the page
 */
export function pickContext(contexts, frameId = null) {
  const usable = contexts.filter(
    (c) => c.auxData?.isDefault !== false && !/isolated/i.test(c.name ?? ""),
  );
  if (usable.length === 0) return null;

  if (frameId) {
    // No fallback. A named frame that has no context is a real answer, and quietly
    // evaluating somewhere else is how the wrong frame gets photographed.
    return usable.find((c) => c.auxData?.frameId === frameId) ?? null;
  }

  // The earliest context, which is the main frame: it was created first.
  return usable.reduce((lowest, c) => (c.id < lowest.id ? c : lowest), usable[0]);
}

/** A console or exception event as one readable line. */
export function formatMessage(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args ?? [])
      .map((a) => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview) : a.type))
      .join(" ");
    return `[${params.type}] ${args}`;
  }
  if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails ?? {};
    return `[throw] ${d.exception?.description ?? d.text ?? "unknown exception"}`;
  }
  if (method === "Log.entryAdded") {
    const e = params.entry ?? {};
    return `[${e.level ?? "log"}] ${e.text ?? ""}${e.url ? ` (${e.url})` : ""}`;
  }
  return null;
}

/**
 * The expression that waits for a condition in the page.
 *
 * Built here rather than inline so the timeout is not forgotten, which is the difference
 * between a failing run and a run that hangs until whatever is watching it gives up. A hang
 * is worse: it has no message and no exit code to read.
 */
export function waitExpression(predicate, timeoutMs) {
  return `new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      try { if (${predicate}) return res(true); } catch (e) { /* not ready yet */ }
      if (Date.now() - t0 > ${timeoutMs}) return rej(new Error(${JSON.stringify(`timed out waiting for: ${predicate}`)}));
      setTimeout(tick, 100);
    };
    tick();
  })`;
}

/**
 * The expression that types into a field.
 *
 * Through the prototype's own value setter, because React and every other framework that
 * tracks input state listens for the event the setter triggers. Assigning `el.value = x`
 * directly changes what is on screen and leaves the framework's state untouched, so the
 * page looks right and behaves as though the field were empty. That cost an hour once.
 */
export function typeExpression(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("no element for " + ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

/** The expression that clicks a control by its visible text. */
export function clickExpression(text) {
  return `(() => {
    const wanted = ${JSON.stringify(text)};
    const all = [...document.querySelectorAll("button, a, [role=button], input[type=submit]")];
    const el = all.find((e) => (e.textContent ?? e.value ?? "").trim() === wanted)
            ?? all.find((e) => (e.textContent ?? e.value ?? "").trim().includes(wanted));
    if (!el) throw new Error("nothing clickable says " + wanted);
    el.click();
    return true;
  })()`;
}
