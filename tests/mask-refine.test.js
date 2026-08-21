import test from "node:test";
import assert from "node:assert/strict";
import {
  boxMean,
  guidedFilterColour,
  colourChannels,
  colourEdgeStrength,
  resampleAlpha,
  buildLocalColourModels,
  colourDistanceMaps,
  reclaimConnectedBackground,
  fillSubjectHoles,
  removeTinyForegroundIslands,
  shapeSurvived,
  refineForegroundAlpha
} from "../src/mask-refine.js";
import {
  SCENE,
  buildScene,
  buildCoarseAlpha,
  regionStats,
  subjectRetention,
  backgroundLeftover
} from "./fixtures/scene.js";

test("box mean averages the requested window and clamps at the borders", () => {
  const width = 4;
  const height = 1;
  const source = Float32Array.from([0, 1, 2, 3]);
  const out = new Float32Array(width * height);
  boxMean(source, width, height, 1, out, new Float64Array((width + 1) * (height + 1)));
  assert.deepEqual([...out], [0.5, 1, 2, 2.5]);
});

test("the colour guide separates two colours of the same brightness", () => {
  // A vertical boundary that is invisible in luma: both sides are ~146.
  const width = 24;
  const height = 8;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const soft = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const left = x < 12;
      rgb[o] = left ? 112 : 149;
      rgb[o + 1] = left ? 150 : 147;
      rgb[o + 2] = left ? 201 : 144;
      rgb[o + 3] = 255;
      // A badly blurred mask ramp that ignores the real boundary.
      soft[i] = Math.min(1, Math.max(0, (20 - x) / 16));
    }
  }
  const guided = guidedFilterColour(colourChannels(rgb, width, height), soft, width, height, 4, 1e-5);
  const insideLeft = guided[4 * width + 6];
  const insideRight = guided[4 * width + 17];
  assert.ok(insideLeft > 0.8, `expected the left colour to be kept, got ${insideLeft}`);
  assert.ok(insideRight < 0.35, `expected the right colour to be released, got ${insideRight}`);

  const edges = colourEdgeStrength(colourChannels(rgb, width, height), width, height);
  assert.ok(edges[4 * width + 12] > 0.05, "the colour boundary must register as an edge");
});

test("alpha resampling interpolates instead of duplicating pixels", () => {
  const out = resampleAlpha(Uint8Array.from([0, 255, 0, 255]), 2, 2, 4, 4);
  assert.equal(out.length, 16);
  const values = new Set(out);
  assert.ok(values.size > 2, "an upscaled mask should contain intermediate values");
});

test("local colour models report how far away their evidence came from", () => {
  const { rgb, width, height } = buildScene();
  const alpha = buildCoarseAlpha();
  const models = buildLocalColourModels(rgb, alpha, width, height);
  assert.ok(models.cellsX > 1 && models.cellsY > 1);
  assert.ok(models.globalBackgroundSamples > 0);
  const scopes = new Set(models.backgroundScope);
  assert.ok(scopes.size > 1, "cells fully inside the mask must widen their search");

  const { toForeground, toBackground, backgroundTrust } = colourDistanceMaps(rgb, models, width, height);
  const gapIndex = 150 * width + 80;
  const legIndex = 150 * width + 60;
  assert.ok(toBackground[gapIndex] < toForeground[gapIndex], "the gap must look like background");
  assert.ok(toForeground[legIndex] < toBackground[legIndex], "a leg must look like the subject");
  assert.ok(backgroundTrust[gapIndex] > 0 && backgroundTrust[gapIndex] <= 1);
});

test("background reclaim only grows from proven background", () => {
  const width = 16;
  const height = 16;
  const total = width * height;
  const alpha = new Uint8Array(total).fill(255);
  const distances = {
    toForeground: new Float32Array(total).fill(200),
    toBackground: new Float32Array(total).fill(5),
    backgroundTrust: new Float32Array(total).fill(1)
  };
  const edges = new Float32Array(total);

  // With no transparent seed there is nothing to grow from.
  const isolated = reclaimConnectedBackground(alpha, distances, edges, width, height);
  assert.equal(isolated.removed, 0);

  // One transparent corner is enough to sweep a uniformly background-like frame.
  alpha[0] = 0;
  const seeded = reclaimConnectedBackground(alpha, distances, edges, width, height);
  assert.ok(seeded.removed > total * 0.9);
});

test("background reclaim refuses pixels that look like the subject or sit behind an edge", () => {
  const width = 8;
  const height = 3;
  const total = width * height;
  const alpha = new Uint8Array(total).fill(255);
  alpha[0] = 0;
  const distances = {
    toForeground: new Float32Array(total).fill(200),
    toBackground: new Float32Array(total).fill(5),
    backgroundTrust: new Float32Array(total).fill(1)
  };
  const edges = new Float32Array(total);

  // Column 3 looks like the subject, so growth stops before it.
  for (let y = 0; y < height; y++) {
    distances.toBackground[y * width + 3] = 180;
    distances.toForeground[y * width + 3] = 4;
  }
  const blockedByColour = reclaimConnectedBackground(alpha, distances, edges, width, height);
  assert.equal(blockedByColour.alpha[1 * width + 2], 0);
  assert.equal(blockedByColour.alpha[1 * width + 5], 255);

  // A strong edge blocks growth even when the colour evidence agrees.
  const plain = {
    toForeground: new Float32Array(total).fill(200),
    toBackground: new Float32Array(total).fill(5),
    backgroundTrust: new Float32Array(total).fill(1)
  };
  const wall = new Float32Array(total);
  for (let y = 0; y < height; y++) wall[y * width + 3] = 0.9;
  const blockedByEdge = reclaimConnectedBackground(alpha, plain, wall, width, height);
  assert.equal(blockedByEdge.alpha[1 * width + 5], 255);
});

test("hole filling closes subject holes and leaves a real gap open", () => {
  const width = 20;
  const height = 20;
  const total = width * height;
  const alpha = new Uint8Array(total).fill(255);
  for (let x = 0; x < width; x++) { alpha[x] = 0; alpha[(height - 1) * width + x] = 0; }
  for (let y = 0; y < height; y++) { alpha[y * width] = 0; alpha[y * width + width - 1] = 0; }

  const subjectHole = { x: 5, y: 5 };
  const backgroundGap = { x: 13, y: 13 };
  const distances = {
    toForeground: new Float32Array(total).fill(120),
    toBackground: new Float32Array(total).fill(120),
    backgroundTrust: new Float32Array(total).fill(1)
  };
  for (let oy = 0; oy < 3; oy++) {
    for (let ox = 0; ox < 3; ox++) {
      const hole = (subjectHole.y + oy) * width + subjectHole.x + ox;
      alpha[hole] = 0;
      distances.toForeground[hole] = 10;
      distances.toBackground[hole] = 150;

      const gap = (backgroundGap.y + oy) * width + backgroundGap.x + ox;
      alpha[gap] = 0;
      distances.toForeground[gap] = 150;
      distances.toBackground[gap] = 10;
    }
  }

  const { alpha: filled } = fillSubjectHoles(alpha, distances, width, height);
  assert.ok(filled[(subjectHole.y + 1) * width + subjectHole.x + 1] > 200, "a subject hole must close");
  assert.equal(filled[(backgroundGap.y + 1) * width + backgroundGap.x + 1], 0, "a real gap must stay open");
});

test("tiny islands go, the main subject stays", () => {
  const width = 40;
  const height = 40;
  const alpha = new Uint8Array(width * height);
  for (let y = 8; y < 32; y++) for (let x = 8; x < 32; x++) alpha[y * width + x] = 255;
  alpha[2 * width + 2] = 255;
  alpha[2 * width + 3] = 255;
  const cleaned = removeTinyForegroundIslands(alpha, width, height);
  assert.equal(cleaned[2 * width + 2], 0);
  assert.equal(cleaned[20 * width + 20], 255);
});

test("shape survival protects the subject extent but tolerates background removal", () => {
  const width = 10;
  const height = 10;
  const before = new Uint8Array(100).fill(255);
  const halved = new Uint8Array(100);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) halved[y * width + x] = 255;
  assert.equal(shapeSurvived(before, halved, width, height, { minArea: 0.9, minSpan: 0.9 }), false);
  assert.equal(shapeSurvived(before, halved, width, height, { minArea: 0.4, minSpan: 0.4 }), true);
  assert.equal(shapeSurvived(before, new Uint8Array(100), width, height), false);
});

test("refinement opens the gap between the legs and clears the halo", async () => {
  const { rgb, truth, width, height } = buildScene();
  const coarse = buildCoarseAlpha();

  const gapBefore = regionStats(coarse, width, SCENE.gap).share;
  const leftoverBefore = backgroundLeftover(coarse, truth);
  assert.ok(gapBefore > 0.95, "the fixture must start with the gap filled in");

  const { alpha, report } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });

  const gapAfter = regionStats(alpha, width, SCENE.gap).share;
  const leftoverAfter = backgroundLeftover(alpha, truth);
  const retained = subjectRetention(alpha, truth);

  assert.ok(report.reclaimed > 0, "the reclaim stage should have found background to remove");
  assert.ok(gapAfter < 0.25, `the gap between the legs should reopen, still ${(gapAfter * 100).toFixed(1)}% filled`);
  assert.ok(leftoverAfter < leftoverBefore * 0.3, `leftover background ${leftoverBefore} -> ${leftoverAfter}`);
  assert.ok(retained > 0.93, `the subject must survive, retained ${retained}`);

  const fragment = regionStats(alpha, width, SCENE.fragment).share;
  assert.ok(fragment < 0.2, `the stray background fragment should be gone, still ${fragment}`);
});

test("refinement keeps the subject when the mask is already correct", async () => {
  const { rgb, truth, width, height } = buildScene();
  const exact = new Uint8Array(width * height);
  for (let i = 0; i < truth.length; i++) exact[i] = truth[i] ? 255 : 0;

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: exact, width, height });
  assert.ok(subjectRetention(alpha, truth) > 0.97, "a correct mask must not be eroded");
  assert.ok(backgroundLeftover(alpha, truth) < 0.02, "a correct mask must not grow");
});

test("refinement never returns an empty cutout", async () => {
  const { rgb, width, height } = buildScene();
  // A hopeless mask that marks the entire frame as subject.
  const everything = new Uint8Array(width * height).fill(255);
  const { alpha } = await refineForegroundAlpha({ rgb, alpha: everything, width, height });
  let visible = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 128) visible++;
  assert.ok(visible > 0, "refinement must never delete everything");
});
