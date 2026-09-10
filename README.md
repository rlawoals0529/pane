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

## Why this exists

I wrote it eleven times.

Eleven one-off scripts across one project, 216 lines between them, each doing the same five
things: open a tab, navigate, evaluate an expression, screenshot a selector, print the
console. Every copy was missing one of the five, and it was rarely the same one. The socket
was never the problem. What was wrong, every time, was one of the four things below.

## The four things every copy got wrong

**Caching.** `Network.setCacheDisabled` was missing from most of them, and it cost the same
hour three separate times: make a fix, re-shoot the page, get the old asset from cache, and
conclude the fix did not work. Nothing about a stale screenshot says it is stale. It is on
unconditionally here and there is no flag to turn it off.

**Fonts.** `document.fonts.ready` is the line people leave out. Without it the first
screenshot catches the fallback face, so the type looks wrong in the image and right in the
browser, and the difference gets blamed on the CSS.

**Negative clips.** An element near the top-left, plus padding, produces negative
coordinates, and **Chrome answers a negative clip with a blank PNG rather than an error.**
That reads as a page that failed to render. Clips are clamped to the page here, and the
padding that gets clipped off the left is not added back on the right, because that would
shift the element off-centre in the image.

**Frames.** This one is genuinely subtle. `--frame` matches against frame URLs and names,
which needs `Page.getFrameTree`, because **an execution context carries a `frameId` and
nothing else**: no URL, no name. Found by dumping the contexts of a page with fifteen
iframes and seeing `{isDefault, type, frameId}` and no more.

The first version of this guessed instead. It took the context whose frame was *not* the
frame owning the isolated context, which is the main frame wherever a preload exists. That
works in Electron and is wrong everywhere else: plain Chrome has no isolated context at all,
so the guess fell through to the earliest context and `--frame` silently returned the outer
page. Silently is the whole problem, because an answer from the wrong frame is
indistinguishable from the right frame not having the element.

A hint that matches no frame now throws. There is no fallback, on purpose.

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
