import test from "node:test";
import assert from "node:assert/strict";
import { computeAssistSelection, applyAssistSelection } from "../src/assist.js";
import { SCENE, buildScene, buildCoarseAlpha, isSubject } from "./fixtures/scene.js";
import { buildTwoToneJacket, buildTwoToneCoarseAlpha, buildShadedNavyCollar } from "./fixtures/jacket.js";
import { regionStats } from "./fixtures/scene.js";

function editorState() {
  const { rgb, truth, width, height } = buildScene();
  const alpha = buildCoarseAlpha();
  const pixels = new Uint8ClampedArray(rgb);
  const original = new Uint8ClampedArray(rgb);
  for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = alpha[i];
  return { rgb: original, pixels, alpha, truth, width, height };
}

function countRemovedSubject(before, after, truth) {
  let lost = 0;
  for (let i = 0; i < truth.length; i++) {
    if (!truth[i]) continue;
    if (before[i * 4 + 3] >= 128 && after[i * 4 + 3] < 128) lost++;
  }
  return lost;
}

test("a tap on background between the legs clears it without touching the legs", () => {
  const editor = editorState();
  const before = new Uint8ClampedArray(editor.pixels);

  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: 80,
    y: 150,
    radius: 26,
    mode: "erase"
  });
  assert.ok(selection, "the tap should produce a selection");

  const changed = applyAssistSelection(editor.pixels, editor.rgb, editor.width, selection, "erase");
  assert.ok(changed > 40, `expected a meaningful removal, changed ${changed}`);

  const centre = (150 * editor.width + 80) * 4 + 3;
  assert.ok(editor.pixels[centre] < 40, "the tapped background must be gone");
  assert.equal(countRemovedSubject(before, editor.pixels, editor.truth), 0, "no leg pixel may be removed");
});

test("a tap right beside the subject trims background instead of biting into it", () => {
  const editor = editorState();
  const before = new Uint8ClampedArray(editor.pixels);

  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: SCENE.leftLeg.x0 - 2,
    y: 150,
    radius: 34,
    mode: "erase"
  });
  assert.ok(selection);
  applyAssistSelection(editor.pixels, editor.rgb, editor.width, selection, "erase");

  const lost = countRemovedSubject(before, editor.pixels, editor.truth);
  assert.ok(lost <= 6, `a nearby tap should barely touch the subject, lost ${lost} pixels`);

  const haloIndex = (150 * editor.width + SCENE.leftLeg.x0 - 3) * 4 + 3;
  assert.ok(editor.pixels[haloIndex] < 128, "the halo beside the leg should be trimmed");
});

test("restore brings back a subject area the mask dropped", () => {
  const editor = editorState();
  for (let y = 140; y < 160; y++) {
    for (let x = 92; x < 108; x++) {
      const i = y * editor.width + x;
      editor.alpha[i] = 0;
      editor.pixels[i * 4 + 3] = 0;
    }
  }

  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: 100,
    y: 150,
    radius: 16,
    mode: "restore"
  });
  assert.ok(selection, "restore should find the hole");
  const changed = applyAssistSelection(editor.pixels, editor.rgb, editor.width, selection, "restore");
  assert.ok(changed > 30, `expected the hole to be refilled, changed ${changed}`);
  assert.ok(editor.pixels[(150 * editor.width + 100) * 4 + 3] > 200, "the hole centre should be opaque again");
  assert.ok(isSubject(100, 150), "sanity: the fixture point is inside the subject");
});

test("restore tap on a navy panel brings the whole panel back", () => {
  const scene = buildTwoToneJacket();
  const { rgb, width, height, collar } = scene;
  const alpha = buildTwoToneCoarseAlpha(scene);
  const pixels = new Uint8ClampedArray(rgb);
  for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = alpha[i];

  const tapX = Math.round((collar.x0 + collar.x1) / 2);
  const tapY = Math.round((collar.y0 + collar.y1) / 2);
  const selection = computeAssistSelection({
    rgb,
    alpha,
    width,
    height,
    x: tapX,
    y: tapY,
    radius: 12,
    mode: "restore"
  });
  assert.ok(selection, "a tap on the missing navy must select it");
  applyAssistSelection(pixels, rgb, width, selection, "restore");

  const restored = new Uint8Array(width * height);
  for (let i = 0; i < restored.length; i++) restored[i] = pixels[i * 4 + 3];
  assert.ok(regionStats(restored, width, collar).share > 0.92, "the whole navy chunk must come back");
  assert.ok(pixels[8 * 4 + 3] < 40, "carpet must stay gone");
});

test("one tap restores a shaded navy panel that used to need many clicks", () => {
  const scene = buildShadedNavyCollar(buildTwoToneJacket());
  const { rgb, width, height, collar } = scene;
  const alpha = buildTwoToneCoarseAlpha(scene);
  const pixels = new Uint8ClampedArray(rgb);
  for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = alpha[i];

  const selection = computeAssistSelection({
    rgb,
    alpha,
    width,
    height,
    x: collar.x0 + 6,
    y: Math.round((collar.y0 + collar.y1) / 2),
    radius: 10,
    mode: "restore"
  });
  assert.ok(selection);
  applyAssistSelection(pixels, rgb, width, selection, "restore");
  const restored = new Uint8Array(width * height);
  for (let i = 0; i < restored.length; i++) restored[i] = pixels[i * 4 + 3];
  assert.ok(regionStats(restored, width, collar).share > 0.95, "one tap must take the whole shaded navy chunk");
});

test("erase tap on leftover carpet clears that colour, not the jacket", () => {
  const scene = buildTwoToneJacket();
  const { rgb, width, height, body } = scene;
  const alpha = new Uint8Array(width * height).fill(255);
  const pixels = new Uint8ClampedArray(rgb);

  const selection = computeAssistSelection({
    rgb,
    alpha,
    width,
    height,
    x: 8,
    y: 8,
    radius: 10,
    mode: "erase"
  });
  assert.ok(selection);
  applyAssistSelection(pixels, rgb, width, selection, "erase");

  const kept = (body.y0 + 20) * width + Math.round((body.x0 + body.x1) / 2);
  assert.ok(pixels[kept * 4 + 3] > 200, "cyan body must stay");
  assert.ok(pixels[(8 * width + 8) * 4 + 3] < 40, "tapped carpet must go");
});

test("a colour chunk is selected solidly, not as a faded circle", () => {
  const editor = editorState();
  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: 80,
    y: 150,
    radius: 26,
    mode: "erase"
  });
  assert.ok(selection);
  let solid = 0;
  for (const weight of selection.weights) if (weight >= 1) solid++;
  assert.ok(solid > 80, `the gap chunk must be a solid selection, got ${solid} pixels`);
});

test("repeated taps keep working and never eat the subject colour", () => {
  const editor = editorState();
  for (let step = 0; step < 4; step++) {
    const selection = computeAssistSelection({
      rgb: editor.rgb,
      alpha: editor.alpha,
      width: editor.width,
      height: editor.height,
      x: 80,
      y: 130 + step * 15,
      radius: 14,
      mode: "erase"
    });
    if (!selection) continue;
    applyAssistSelection(editor.pixels, editor.rgb, editor.width, selection, "erase");
    for (let i = 0; i < editor.alpha.length; i++) editor.alpha[i] = editor.pixels[i * 4 + 3];
  }

  let subjectLost = 0;
  for (let i = 0; i < editor.truth.length; i++) {
    if (editor.truth[i] && editor.pixels[i * 4 + 3] < 128) subjectLost++;
  }
  assert.equal(subjectLost, 0, "consecutive corrections must not corrupt the subject");
  assert.ok(editor.pixels[(150 * editor.width + 80) * 4 + 3] < 40, "the gap should be cleared by now");
});

test("a target with nothing to change reports back instead of guessing", () => {
  const editor = editorState();
  // Exact mask: leftover background is already gone, so a tap on carpet
  // has no opaque pixels of that colour left to erase.
  for (let i = 0; i < editor.truth.length; i++) {
    const a = editor.truth[i] ? 255 : 0;
    editor.alpha[i] = a;
    editor.pixels[i * 4 + 3] = a;
  }
  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: 8,
    y: 8,
    radius: 12,
    mode: "erase"
  });
  const changed = selection
    ? applyAssistSelection(editor.pixels, editor.rgb, editor.width, selection, "erase")
    : 0;
  assert.equal(changed, 0, "already-transparent background must report no change");
});
