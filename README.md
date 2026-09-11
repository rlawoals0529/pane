# pane

Drive a Chrome tab from a script. Navigate, run something in it, photograph an element, read
what it logged.

```bash
pane http://localhost:5173/ shot.png
pane http://localhost:5173/ card.png --selector "[data-testid=summary]" --pad 24
pane http://localhost:5173/ --evaluate "document.title"
pane http://localhost:5173/ --console --evaluate "1"
```

No dependencies. The DevTools Protocol is a JSON envelope over a socket, and Node has had a
`WebSocket` and a `fetch` for years, so a library to send one is a library to maintain.

## Install

```bash
git clone https://github.com/rlawoals0529/pane && cd pane && npm link
```

Needs a Chrome or Chromium on the machine. Nothing else.

## What it handles for you

Four things every hand-rolled version of this gets wrong, found across eleven one-off scripts
in one project that came to 216 lines between them:

**Caching is off.** `Network.setCacheDisabled`, unconditionally, with no flag to turn it back
on. Without it you fix something, re-shoot the page, get the old asset, and conclude the fix
did not work. Nothing about a stale screenshot says it is stale.

**Fonts are waited for.** `document.fonts.ready` before the shot, so the image does not catch
the fallback face and leave you blaming the CSS.

**Clips are clamped.** An element near the top-left plus padding gives negative coordinates,
and Chrome answers a negative clip with a blank PNG rather than an error. Padding lost off
the left is not added back on the right, which would shift the element off-centre.

**Frames are matched, not guessed.** `--frame` matches real frame URLs and names via
`Page.getFrameTree`, because an execution context carries a `frameId` and nothing else. A
hint that matches no frame throws rather than falling back, since an answer from the wrong
frame is indistinguishable from the right frame not having the element.

## Options

| | |
| --- | --- |
| `--selector CSS` | photograph one element rather than the page |
| `--pad N` | padding around it, in CSS pixels (default 20; `0` is allowed) |
| `--width` `--height` `--scale` | viewport, and device pixel ratio (default 1280x900 at 2x) |
| `--no-full-page` | stop at the viewport instead of the whole scroll height |
| `--evaluate EXPR` | run an expression and print the result |
| `--frame HINT` | run it in the frame whose URL or name contains HINT |
| `--driver PATH` | a module whose default export gets the tab, for anything scripted |
| `--settle MS` | wait after load, before the shot (default 600; `0` is allowed) |
| `--console` | print everything the page logged, and every exception |
| `--port N` | the browser's debugging port (default 9222) |

Every failure prints one sentence. An error thrown inside the page is trimmed to its first
line, because the rest is a stack of an expression this tool built and the line numbers
point at nothing a reader can open.

## As a library

```js
import { open } from "pane";

const tab = await open({ port: 9222, console: true });
await tab.viewport({ width: 1440, height: 900, scale: 2 });
await tab.go("http://localhost:5173/");

await tab.type("[data-testid=input]", "a value");
await tab.click("Analyse");
await tab.wait(`document.querySelectorAll(".result").length > 0`);

const png = await tab.shot({ selector: ".results", pad: 24 });
console.log(tab.log());
tab.close();
```

`type` goes through the prototype's own value setter, which matters more than it looks:
assigning `el.value = x` changes what is on screen and leaves React's state untouched, so
the page looks right and behaves as though the field were empty.

`wait` carries its own timeout. A hang has no message and no exit code, which makes it worse
than a failure by a wide margin.

## Running code in a page

`tab.eval` sends a string to `Runtime.evaluate`, which is what a tool like this is for:
there is no way to ask a page what it looks like without running something in it. Nothing
here evaluates in the driver process. The strings come from two places only, the expressions
this repo builds and whatever you typed on your own command line, so a hostile page has no
path back into what gets run in it.

**A session is as privileged as the browser it attaches to.** Point it at a throwaway
profile, not at the browser holding your logged-in sessions:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/pane-profile
```

That flag is in the error message you get when nothing is listening, for the same reason.

## Tests

```bash
npm test
```

Forty-one, all against the pure half: argument parsing, clip arithmetic, frame resolution,
message formatting, and the expressions. That split is the only reason any of it is tested,
because a driver that talks to a browser is otherwise testable exclusively by having a
browser, and the parts that were actually wrong were never the socket.

MIT
