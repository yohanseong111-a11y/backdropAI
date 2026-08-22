import test from "node:test";
import assert from "node:assert/strict";
import {
  frameCoverage,
  invertAlpha,
  maskLooksInverted,
  restoreSubjectColouredGaps,
  recoverDeletedSubject,
  cornerBackgroundSeed
} from "../src/mask-recover.js";
import { refineForegroundAlpha } from "../src/mask-refine.js";
import {
  JACKET,
  buildJacketScene,
  buildJacketCoarseAlpha,
  buildFullBleedJacket,
  buildFullBleedCoarseAlpha,
  buildLitJacketScene,
  buildLitJacketShadowWipe,
  isJacket
} from "./fixtures/jacket.js";
import { regionStats, subjectRetention, backgroundLeftover } from "./fixtures/scene.js";

test("a kept centre subject is not treated as inverted", () => {
  const width = 20;
  const height = 20;
  const alpha = new Uint8Array(width * height);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) alpha[y * width + x] = 255;
  const coverage = frameCoverage(alpha, width, height);
  assert.ok(coverage.interiorOpaque > coverage.borderOpaque);
  assert.equal(maskLooksInverted(alpha, width, height), false);
});

test("a hollow frame with an empty middle is inverted", () => {
  const width = 20;
  const height = 20;
  const alpha = new Uint8Array(width * height).fill(255);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) alpha[y * width + x] = 0;
  assert.equal(maskLooksInverted(alpha, width, height), true);
  assert.equal(invertAlpha(alpha)[10 * width + 10], 255);
});

test("subject-coloured bites that touch the photo edge are restored", () => {
  const { rgb, width, height } = buildJacketScene();
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isJacket(x, y)) alpha[y * width + x] = 255;
    }
  }
  // A wound from the left crop into the jacket — the case border-seeded reclaim
  // used to call "proven background" and then eat the rest of the fabric.
  for (let y = 40; y < 90; y++) {
    for (let x = 0; x < 70; x++) {
      if (isJacket(x, y)) alpha[y * width + x] = 0;
    }
  }
  const { alpha: restored, restored: count } = restoreSubjectColouredGaps(rgb, alpha, width, height);
  assert.ok(count > 80, `expected to grow the jacket back, restored ${count}`);
  assert.ok(restored[60 * width + 50] > 200, "the edge bite must close");
  assert.equal(restored[8 * width + 8], 0, "carpet at the frame must stay empty");
});

test("an inverted jacket mask is flipped and the carpet stays gone", async () => {
  const { rgb, truth, width, height } = buildJacketScene();
  const inverted = new Uint8Array(width * height);
  for (let i = 0; i < truth.length; i++) inverted[i] = truth[i] ? 0 : 255;

  assert.equal(maskLooksInverted(inverted, width, height), true);
  const recovered = recoverDeletedSubject(rgb, inverted, width, height);
  assert.equal(recovered.inverted, true);
  assert.ok(subjectRetention(recovered.alpha, truth) > 0.9);

  const { alpha, report } = await refineForegroundAlpha({ rgb, alpha: inverted, width, height });
  assert.equal(report.inverted, true);
  assert.ok(subjectRetention(alpha, truth) > 0.94, `jacket retained ${subjectRetention(alpha, truth)}`);
  assert.ok(backgroundLeftover(alpha, truth) < 0.1, `carpet leftover ${backgroundLeftover(alpha, truth)}`);
});

test("a full-bleed jacket hole closes even when the photo border is the jacket", async () => {
  const scene = buildFullBleedJacket();
  const { rgb, truth, width, height, hole } = scene;
  const coarse = buildFullBleedCoarseAlpha(scene);
  assert.equal(regionStats(coarse, width, hole).share, 0, "the fixture starts with a hole in the coat");

  const seed = cornerBackgroundSeed(rgb, width, height);
  assert.ok(seed, "top corners are carpet, so the backdrop seed must be found");

  const recovered = recoverDeletedSubject(rgb, coarse, width, height);
  assert.ok(regionStats(recovered.alpha, width, hole).share > 0.85, "recovery must close the hole");

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });
  assert.ok(regionStats(alpha, width, hole).share > 0.9, "refine must keep the hole closed");
  assert.ok(subjectRetention(alpha, truth) > 0.94, `jacket retained ${subjectRetention(alpha, truth)}`);
  assert.ok(backgroundLeftover(alpha, truth) < 0.12, `carpet leftover ${backgroundLeftover(alpha, truth)}`);
});

test("a shadowed jacket side that the model deleted still comes back", async () => {
  const scene = buildLitJacketScene();
  const { rgb, truth, width, height, shadow } = scene;
  const coarse = buildLitJacketShadowWipe(scene);
  assert.ok(subjectRetention(coarse, truth) < 0.82, "the fixture starts with the shadow wiped");
  assert.equal(regionStats(coarse, width, shadow).share, 0);

  const recovered = recoverDeletedSubject(rgb, coarse, width, height);
  assert.ok(regionStats(recovered.alpha, width, shadow).share > 0.9, "recovery must walk across the lighting change");

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });
  assert.ok(regionStats(alpha, width, shadow).share > 0.9, "refine must keep the shadowed fabric");
  assert.ok(subjectRetention(alpha, truth) > 0.94, `jacket retained ${subjectRetention(alpha, truth)}`);
  assert.ok(backgroundLeftover(alpha, truth) < 0.1, `carpet leftover ${backgroundLeftover(alpha, truth)}`);
});

test("a jacket bite that reaches the frame is repaired by the full refine pass", async () => {
  const { rgb, truth, width, height } = buildJacketScene();
  const coarse = buildJacketCoarseAlpha();
  for (let y = JACKET.body.y0; y < JACKET.body.y0 + 40; y++) {
    for (let x = 0; x < JACKET.body.x0 + 24; x++) coarse[y * width + x] = 0;
  }
  const edgeWound = { x0: JACKET.body.x0, x1: JACKET.body.x0 + 24, y0: JACKET.body.y0, y1: JACKET.body.y0 + 40 };
  assert.equal(regionStats(coarse, width, edgeWound).share, 0);

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });
  assert.ok(regionStats(alpha, width, edgeWound).share > 0.85, "the edge wound must close");
  assert.ok(subjectRetention(alpha, truth) > 0.94);
  assert.ok(backgroundLeftover(alpha, truth) < 0.1);
});
