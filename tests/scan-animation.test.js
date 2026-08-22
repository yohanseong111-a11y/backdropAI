import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../src/editor.css", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");

test("the processing scan moves one way on the compositor, never bouncing on `top`", () => {
  assert.match(css, /animation:scanTrackSweep 1\.35s linear infinite;/);
  assert.doesNotMatch(css, /scanTrackSweep[^;]*alternate/);
  assert.doesNotMatch(css, /@keyframes scanSweepFast/);
  assert.match(css, /from\{transform:translate3d\(0,-100%,0\)\}/);
  assert.match(css, /to\{transform:translate3d\(0,100%,0\)\}/);
});

test("the reveal wipe uses a transforming track instead of animating `top`", () => {
  assert.match(css, /@keyframes revealTrack/);
  assert.match(main, /class="reveal-track"/);
  assert.doesNotMatch(css, /@keyframes revealLineDown/);
});
