#!/usr/bin/env node
/**
 * pane <url> [out.png] [options]
 *
 * The command that replaces eleven one-off scripts. Everything it does was in at least one
 * of them; nothing in it is new.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { open } from "./index.js";
import { parseArgs } from "./pure.js";

const USAGE = `pane <url> [out.png] [options]

  --selector CSS     photograph one element rather than the page
  --pad N            padding around it, in CSS pixels (default 20)
  --width N          viewport width (default 1280)
  --height N         viewport height (default 900)
  --scale N          device pixel ratio (default 2)
  --no-full-page     stop at the viewport instead of the whole scroll height
  --evaluate EXPR    run an expression in the page and print the result
  --frame HINT       run it in the frame whose URL contains HINT
  --driver PATH      a module whose default export gets the tab, for anything scripted
  --settle MS        wait after load, before the shot (default 600)
  --console          print everything the page logged, and every exception
  --port N           the browser's debugging port (default 9222)

Start a browser first, on a throwaway profile:
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
    --remote-debugging-port=9222 --user-data-dir=/tmp/pane-profile`;

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`pane: ${parsed.reason}\n\n${USAGE}`);
  process.exit(2);
}
const { opts } = parsed;

/**
 * Everything below runs inside one catch, and the catch prints a sentence.
 *
 * Without it a rejected promise reaches Node's own handler, which prints a stack trace and
 * a version banner. That is the exact failure this tool exists to stop: an error nobody can
 * read is only marginally better than no error, and it sends the reader into the driver
 * rather than at the thing that is actually wrong.
 */
let tab;
try {
  tab = await open({ port: opts.port, console: opts.console });
} catch (e) {
  console.error(`pane: ${e.message}`);
  process.exit(1);
}

try {
  await tab.viewport({ width: opts.width, height: opts.height, scale: opts.scale });
  await tab.go(opts.url);

  // A driver runs before anything is measured, because its whole job is to put the page in
  // the state worth photographing.
  if (opts.driver) {
    const mod = await import(pathToFileURL(opts.driver).href);
    if (typeof mod.default !== "function") {
      throw new Error(`${opts.driver} has no default export to call`);
    }
    await mod.default(tab);
  }

  if (opts.settle) await tab.settle(opts.settle);

  if (opts.evaluate) {
    const value = await tab.eval(opts.evaluate, { frame: opts.frame });
    // Objects as JSON so a shell can pipe them somewhere; strings bare so they are usable.
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }

  if (opts.out) {
    const png = await tab.shot({ selector: opts.selector, pad: opts.pad, fullPage: opts.fullPage });
    writeFileSync(opts.out, png);
    console.error(`pane: wrote ${opts.out} (${(png.length / 1024).toFixed(0)} KB)`);
  }

  if (opts.console) {
    const lines = tab.log();
    // Said out loud either way. "Nothing was logged" and "the log was not collected" look
    // identical when the answer is silence, and one of them means the run proved nothing.
    console.error(lines.length ? `pane: page said:\n${lines.map((l) => `  ${l}`).join("\n")}` : "pane: the page logged nothing");
  }
} catch (e) {
  console.error(`pane: ${e.message}`);
  tab.close();
  process.exit(1);
} finally {
  tab.close();
}

// Explicit, because an open socket keeps the process alive and a command that never exits
// looks like a command that hung.
process.exit(0);
