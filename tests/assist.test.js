import test from "node:test";
import assert from "node:assert/strict";
import { computeAssistSelection, applyAssistSelection } from "../src/assist.js";
import { SCENE, buildScene, buildCoarseAlpha, isSubject } from "./fixtures/scene.js";

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

test("nothing outside the target circle can ever change", () => {
  const editor = editorState();
  const radius = 18;
  const x = 80;
  const y = 150;

  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x, y, radius,
    mode: "erase"
  });
  assert.ok(selection);

  for (let by = 0; by < selection.height; by++) {
    for (let bx = 0; bx < selection.width; bx++) {
      if (selection.weights[by * selection.width + bx] <= 0) continue;
      const distance = Math.hypot(selection.x0 + bx - x, selection.y0 + by - y);
      assert.ok(distance <= radius + 1e-6, `weight found ${distance.toFixed(2)}px away with radius ${radius}`);
    }
  }
});

test("a tap right beside the subject trims background instead of biting into it", () => {
  const editor = editorState();
  const before = new Uint8ClampedArray(editor.pixels);

  // Two pixels outside the left leg, inside the halo the mask wrongly kept.
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

test("a tap in the middle of the subject stays contained", () => {
  const editor = editorState();
  const before = new Uint8ClampedArray(editor.pixels);
  const radius = 30;

  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: 80,
    y: 60,
    radius,
    mode: "erase"
  });

  if (selection) {
    applyAssistSelection(editor.pixels, editor.rgb, editor.width, selection, "erase");
    const lost = countRemovedSubject(before, editor.pixels, editor.truth);
    // The user asked for this, so a removal is allowed — but only inside the target.
    assert.ok(lost <= Math.PI * radius * radius, "removal must stay within the target area");
    for (let i = 0; i < editor.truth.length; i++) {
      if (before[i * 4 + 3] < 128 || editor.pixels[i * 4 + 3] >= 128) continue;
      const x = i % editor.width;
      const y = (i / editor.width) | 0;
      assert.ok(Math.hypot(x - 80, y - 60) <= radius + 1, "a change appeared outside the target");
    }
  }
});

test("target size scales the analysed area", () => {
  const editor = editorState();
  const shared = {
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: 80,
    y: 150,
    mode: "erase"
  };
  const small = computeAssistSelection({ ...shared, radius: 8 });
  const large = computeAssistSelection({ ...shared, radius: 34 });
  assert.ok(small && large);
  assert.ok(large.accepted > small.accepted * 3, `small ${small.accepted} vs large ${large.accepted}`);
});

test("removal edges are feathered rather than a hard circle", () => {
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
  let partial = 0;
  for (const weight of selection.weights) if (weight > 0.05 && weight < 0.95) partial++;
  assert.ok(partial > 20, `expected a soft transition band, found ${partial} partial weights`);
});

test("restore brings back a subject area the mask dropped", () => {
  const editor = editorState();
  // Punch a hole in the middle of the right leg, as an over-eager erase would.
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

test("repeated taps keep working and never grow past the target", () => {
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
  // Fully transparent corner: there is no background left to erase there.
  const selection = computeAssistSelection({
    rgb: editor.rgb,
    alpha: editor.alpha,
    width: editor.width,
    height: editor.height,
    x: 140,
    y: 20,
    radius: 12,
    mode: "erase"
  });
  const changed = selection
    ? applyAssistSelection(editor.pixels, editor.rgb, editor.width, selection, "erase")
    : 0;
  assert.equal(changed, 0, "already-transparent background must report no change");
});
