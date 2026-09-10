import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clickExpression,
  clipFor,
  findFrame,
  flattenFrames,
  formatMessage,
  parseArgs,
  pickContext,
  typeExpression,
  waitExpression,
} from "../src/pure.js";

/** A real Page.getFrameTree response shape, nested one level. */
const FRAME_TREE = {
  frame: { id: "OUTER", url: "http://127.0.0.1:8930/preview/index.html", name: "" },
  childFrames: [
    { frame: { id: "F1", url: "http://127.0.0.1:8930/widgets/clock/index.html", name: "" } },
    { frame: { id: "F2", url: "http://127.0.0.1:8930/widgets/weather/index.html", name: "wx" } },
    {
      frame: { id: "F3", url: "http://127.0.0.1:8930/widgets/shader/index.html", name: "" },
      childFrames: [{ frame: { id: "F4", url: "about:blank", name: "deep" } }],
    },
  ],
};

test("a url and an output file are enough", () => {
  const r = parseArgs(["http://127.0.0.1:8080/", "out.png"]);
  assert.equal(r.ok, true);
  assert.equal(r.opts.url, "http://127.0.0.1:8080/");
  assert.equal(r.opts.out, "out.png");
});

test("a path with no scheme is refused rather than resolved against about:blank", () => {
  // Navigating to a bare path silently shows nothing, and the screenshot that comes back
  // looks like a page that failed to render.
  const r = parseArgs(["preview/index.html"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no scheme/);
});

test("file:// is a scheme", () => {
  assert.equal(parseArgs(["file:///tmp/x.html"]).ok, true);
});

test("no url at all is refused", () => {
  assert.match(parseArgs([]).reason, /give a URL/);
});

test("a flag with no value is a typo, not a flag with the next flag as its value", () => {
  // Otherwise --width consumes --height and the viewport is NaN wide, which produces a
  // screenshot nobody can account for.
  const r = parseArgs(["http://x/", "--width", "--height", "700"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /--width needs a value/);
});

test("a trailing flag with nothing after it is refused", () => {
  assert.match(parseArgs(["http://x/", "--selector"]).reason, /needs a value/);
});

test("an unknown flag is named rather than ignored", () => {
  // Ignoring it means a mistyped --seletcor produces a full-page shot and no complaint.
  assert.match(parseArgs(["http://x/", "--seletcor", ".x"]).reason, /unknown option --seletcor/);
});

test("a number option that is not a number is refused", () => {
  for (const bad of ["abc", "0", "-5", ""]) {
    const r = parseArgs(["http://x/", "--width", bad]);
    assert.equal(r.ok, false, bad);
  }
});

test("boolean flags take no value", () => {
  const r = parseArgs(["http://x/", "out.png", "--console", "--no-full-page"]);
  assert.equal(r.ok, true);
  assert.equal(r.opts.console, true);
  assert.equal(r.opts.fullPage, false);
});

test("the defaults are what they are", () => {
  // Written out rather than read from the module. These end up in every screenshot, and a
  // scale that quietly became 1 makes every image look soft with nothing to point at.
  const { opts } = parseArgs(["http://x/"]);
  assert.equal(opts.width, 1280);
  assert.equal(opts.height, 900);
  assert.equal(opts.scale, 2);
  assert.equal(opts.pad, 20);
  assert.equal(opts.port, 9222);
  assert.equal(opts.settle, 600);
  assert.equal(opts.fullPage, true);
});

test("a clip is padded on every side", () => {
  const c = clipFor({ x: 100, y: 200, width: 300, height: 150 }, 20, { width: 1280, height: 2000 });
  assert.deepEqual(c, { x: 80, y: 180, width: 340, height: 190, scale: 1 });
});

test("a clip never has negative coordinates", () => {
  // The most common failure in every hand-written copy of this. Chrome answers a negative
  // clip with a blank image rather than an error, so it reads as a page that did not render.
  const c = clipFor({ x: 5, y: 0, width: 200, height: 100 }, 20, { width: 1280, height: 900 });
  assert.equal(c.x, 0);
  assert.equal(c.y, 0);
  assert.ok(c.width > 0 && c.height > 0);
});

test("padding clipped off the left is not added back on the right", () => {
  // An element 5px from the edge with 20px of padding can only have 5px of it, and adding
  // the full 40 would shift the element off-centre in the image.
  const c = clipFor({ x: 5, y: 100, width: 200, height: 100 }, 20, { width: 1280, height: 900 });
  assert.equal(c.x, 0);
  assert.equal(c.width, 225);
});

test("a clip never runs past the page", () => {
  const c = clipFor({ x: 1200, y: 800, width: 200, height: 200 }, 20, { width: 1280, height: 900 });
  assert.ok(c.x + c.width <= 1280, `${c.x} + ${c.width} > 1280`);
  assert.ok(c.y + c.height <= 900, `${c.y} + ${c.height} > 900`);
});

test("a zero-sized element still produces a clip with area", () => {
  // A zero-height clip is a blank PNG. One pixel is not useful either, but it is visibly
  // wrong rather than invisibly wrong.
  const c = clipFor({ x: 10, y: 10, width: 0, height: 0 }, 0, { width: 100, height: 100 });
  assert.ok(c.width >= 1 && c.height >= 1);
});

test("a page smaller than the padding does not produce a clip larger than the page", () => {
  const c = clipFor({ x: 0, y: 0, width: 50, height: 50 }, 500, { width: 60, height: 60 });
  assert.ok(c.width <= 60 && c.height <= 60);
});

test("the main frame is picked when there is only one", () => {
  const contexts = [{ id: 1, origin: "https://x", auxData: { isDefault: true, frameId: "A" } }];
  assert.equal(pickContext(contexts).id, 1);
});

test("the frame tree flattens, including a frame inside a frame", () => {
  const frames = flattenFrames(FRAME_TREE);
  assert.deepEqual(frames.map((f) => f.id), ["OUTER", "F1", "F2", "F3", "F4"]);
});

test("a malformed frame tree flattens to nothing rather than throwing", () => {
  for (const bad of [null, undefined, {}, { frame: null }, { childFrames: [] }]) {
    assert.deepEqual(flattenFrames(bad), [], JSON.stringify(bad));
  }
});

test("a frame is found by a substring of its URL", () => {
  assert.equal(findFrame(flattenFrames(FRAME_TREE), "clock").id, "F1");
  assert.equal(findFrame(flattenFrames(FRAME_TREE), "widgets/shader").id, "F3");
});

test("a frame is found by its name when the URL does not say", () => {
  assert.equal(findFrame(flattenFrames(FRAME_TREE), "wx").id, "F2");
  assert.equal(findFrame(flattenFrames(FRAME_TREE), "deep").id, "F4");
});

test("no hint means the main frame", () => {
  assert.equal(findFrame(flattenFrames(FRAME_TREE), null).id, "OUTER");
});

test("a hint that matches nothing is null, not the outer page", () => {
  // Falling back is what made --frame silently return the wrong document. An answer from
  // the wrong frame is indistinguishable from the frame simply not having the element.
  assert.equal(findFrame(flattenFrames(FRAME_TREE), "nosuchthing"), null);
});

test("the context for a frame is the one carrying its id", () => {
  // A context carries a frameId and nothing else useful: no URL, no name. Verified by
  // dumping the contexts of a page with fifteen iframes, which is why the frame tree above
  // has to exist at all.
  const contexts = [
    { id: 2, auxData: { isDefault: true, frameId: "OUTER" } },
    { id: 3, auxData: { isDefault: true, frameId: "F1" } },
    { id: 4, auxData: { isDefault: true, frameId: "F2" } },
  ];
  assert.equal(pickContext(contexts, "F1").id, 3);
  assert.equal(pickContext(contexts, "F2").id, 4);
});

test("a frame with no context yet is null rather than somewhere else", () => {
  const contexts = [{ id: 2, auxData: { isDefault: true, frameId: "OUTER" } }];
  assert.equal(pickContext(contexts, "F9"), null);
});

test("with no frame asked for, the earliest context wins, because it is the main frame", () => {
  const contexts = [
    { id: 5, auxData: { isDefault: true, frameId: "F1" } },
    { id: 2, auxData: { isDefault: true, frameId: "OUTER" } },
    { id: 9, auxData: { isDefault: true, frameId: "F2" } },
  ];
  assert.equal(pickContext(contexts).id, 2);
});

test("an isolated context is never evaluated in", () => {
  // It has its own globals and none of the page's, so an expression that reads the DOM
  // returns undefined there and looks like an empty page.
  const contexts = [
    { id: 1, origin: "file://", name: "Electron Isolated Context", auxData: { isDefault: false, frameId: "A" } },
    { id: 2, origin: "file://", auxData: { isDefault: true, frameId: "A" } },
  ];
  assert.equal(pickContext(contexts).id, 2);
});

test("no contexts is null rather than a throw", () => {
  assert.equal(pickContext([]), null);
});

test("a console call reads as one line", () => {
  const line = formatMessage("Runtime.consoleAPICalled", { type: "warning", args: [{ value: "careful" }] });
  assert.equal(line, "[warning] careful");
});

test("an exception reads as one line", () => {
  const line = formatMessage("Runtime.exceptionThrown", {
    exceptionDetails: { exception: { description: "TypeError: x is not a function" } },
  });
  assert.match(line, /^\[throw\] TypeError/);
});

test("an argument with no value falls back to its description rather than to undefined", () => {
  const line = formatMessage("Runtime.consoleAPICalled", { type: "log", args: [{ description: "Object" }] });
  assert.equal(line, "[log] Object");
});

test("a method that is not a message is null, so it can be filtered without a special case", () => {
  assert.equal(formatMessage("Page.frameNavigated", {}), null);
});

test("a wait carries its own timeout, so a failing condition fails rather than hangs", () => {
  // A hang has no message and no exit code. It is worse than a failure by a wide margin.
  const expr = waitExpression("document.title !== ''", 5000);
  assert.match(expr, /Date\.now\(\) - t0 > 5000/);
  assert.match(expr, /timed out waiting for/);
});

test("a wait predicate that throws is treated as not ready, not as a failure", () => {
  // Reading a property of an element that does not exist yet throws, and that is the normal
  // state of a page that is still loading.
  assert.match(waitExpression("a.b.c", 100), /catch/);
});

test("typing goes through the prototype setter", () => {
  // Assigning el.value directly changes the screen and leaves React's state untouched, so
  // the page looks right and behaves as though the field were empty.
  const expr = typeExpression("#in", "hello");
  assert.match(expr, /getOwnPropertyDescriptor/);
  assert.match(expr, /dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
});

test("typing a value with quotes in it is escaped", () => {
  const expr = typeExpression("#in", 'he said "hi" \\ then left');
  assert.ok(expr.includes(JSON.stringify('he said "hi" \\ then left')));
});

test("a selector with quotes in it is escaped", () => {
  const expr = typeExpression('[data-x="y"]', "v");
  assert.ok(expr.includes(JSON.stringify('[data-x="y"]')));
});

test("clicking prefers an exact label over one that merely contains it", () => {
  // Otherwise "Save" clicks "Save and close", which is a different action.
  const expr = clickExpression("Save");
  const exactFirst = expr.indexOf(".trim() === wanted");
  const containsSecond = expr.indexOf(".includes(wanted)");
  assert.ok(exactFirst < containsSecond && exactFirst !== -1);
});

test("clicking throws when nothing matches, rather than doing nothing", () => {
  assert.match(clickExpression("Nope"), /throw new Error/);
});

test("zero is allowed where zero means something", () => {
  // --pad 0 is "clip to the element exactly" and --settle 0 is "do not wait". Both were
  // refused by a validator that required every number to be positive.
  assert.equal(parseArgs(["http://x/", "--pad", "0"]).opts.pad, 0);
  assert.equal(parseArgs(["http://x/", "--settle", "0"]).opts.settle, 0);
});

test("zero is still refused where it means nothing", () => {
  for (const name of ["width", "height", "scale", "port"]) {
    assert.equal(parseArgs(["http://x/", `--${name}`, "0"]).ok, false, name);
  }
});
