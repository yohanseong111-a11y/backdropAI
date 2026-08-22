import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

test("segmentation is the primary route and the colour flood is only a fallback", () => {
  const route = section("async function chooseSafeCutout", "function nextFrame");
  assert.match(route, /removeWithBackshotEngine\(file/);
  const fallbackIndex = route.indexOf("conservativeCloseupFallback");
  const catchIndex = route.indexOf("catch(aiError)");
  assert.ok(catchIndex > 0 && fallbackIndex > catchIndex, "the colour fallback must only run after the model fails");
});

test("every cutout goes through the same refinement before it is composited", () => {
  const apply = section("async function applyDualMaskToFile", "function warmBackshotEngine");
  assert.match(apply, /resampleAlpha\(rawAlpha,maskWidth,maskHeight/);
  assert.match(apply, /refineAlphaOffMainThread/);
  assert.match(apply, /refineForegroundAlpha\(/);
  assert.match(apply, /globalCompositeOperation="destination-in"/);
  assert.match(apply, /imageSmoothingQuality="high"/);
  // The refined mask is applied to the original at its own size: no crop, no stretch.
  assert.match(apply, /outCanvas\.width=fullWidth;outCanvas\.height=fullHeight/);
});

test("refinement runs at a bounded working resolution instead of full resolution", () => {
  assert.match(source, /const REFINE_MAX_SIDE\s*=\s*\{/);
  assert.match(source, /function refineWorkingSize\(width,height,profile\)/);
  const apply = section("async function applyDualMaskToFile", "function warmBackshotEngine");
  assert.match(apply, /refineWorkingSize\(fullWidth,fullHeight,profile\)/);
  assert.doesNotMatch(apply, /getImageData\(0,0,fullWidth,fullHeight\)/);
});

test("edge decontamination is streamed in strips so large photos cannot exhaust memory", () => {
  const strips = section("async function decontaminateEdgesInStrips", "function refineWorkingSize");
  assert.match(strips, /for\(let y=0;y<height;y\+=stripHeight\)/);
  assert.match(strips, /ctx\.putImageData\(composed,0,y\)/);
});

test("batch inference cannot overlap one ONNX session and always releases UI state", () => {
  const queue = section("async function processRemovalQueue", "async function removeSelectedBackgrounds");
  assert.match(queue, /for\(const item of queue\)/);
  assert.doesNotMatch(queue, /Promise\.all\(chunk\.map/);
  assert.match(queue, /finally\{/);
  assert.match(queue, /state\.processing=false/);
  // Photos that already have a cutout are never processed again.
  assert.match(queue, /filter\(item=>item&&!item\.cutoutBlob\)/);
});

test("remove selected and remove all read different sets of photos", () => {
  const selected = section("async function removeSelectedBackgrounds", "async function removeAllBackgrounds");
  const all = section("async function removeAllBackgrounds", "function updateProgress");
  assert.match(selected, /selectedItems\(\)/);
  assert.doesNotMatch(selected, /processRemovalQueue\(state\.items/);
  assert.match(all, /processRemovalQueue\(state\.items/);
  assert.doesNotMatch(all, /selectedItems\(\)/);
});

test("two photos sharing a filename get separate entries in the ZIP", () => {
  const naming = section("function exportNameFor", "async function renderExport");
  assert.match(naming, /while\(taken\.has\(name\)\)/);
  const download = section("async function downloadItems", "async function downloadSelected");
  assert.match(download, /const taken=new Set\(\)/);
  assert.match(download, /exportNameFor\(item,counter,taken\)/);
});

test("exports only ever contain finished cutouts", () => {
  const download = section("async function downloadItems", "async function downloadSelected");
  assert.match(download, /const items=processedItems\(candidates\)/);
  assert.match(source, /function isProcessed\(item\)\{ return item\.status === "done" && !!item\.cutoutBlob; \}/);
  const render = section("async function renderExport", "async function downloadItems");
  assert.match(render, /imageFromURL\(item\.cutoutURL\)/);
  assert.doesNotMatch(render, /item\.originalURL/);
});
