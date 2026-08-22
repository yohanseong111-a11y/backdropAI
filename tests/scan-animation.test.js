import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../src/editor.css", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");

test("the processing scan is a visible bar that travels down then up", () => {
  assert.match(css, /animation:scanSweep 1\.2s ease-in-out infinite;/);
  assert.match(css, /50%\{top:calc\(100% - 8px\)\}/);
  assert.match(main, /class="scan-overlay"/);
  assert.match(main, /class="scan-travel"/);
  assert.match(main, /class="scan-bar"/);
  assert.doesNotMatch(css, /translate3d\(0,100%,0\)/);
});

test("the reveal wipe uses a transforming track instead of animating `top`", () => {
  assert.match(css, /@keyframes revealTrack/);
  assert.match(main, /class="reveal-track"/);
  assert.doesNotMatch(css, /@keyframes revealLineDown/);
});
