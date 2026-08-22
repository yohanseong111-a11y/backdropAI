import test from "node:test";
import assert from "node:assert/strict";
import {
  frameCoverage,
  invertAlpha,
  maskLooksInverted,
  restoreSubjectColouredGaps,
  recoverDeletedSubject,
  cornerBackgroundSeed,
  restoreNonBackgroundPanels,
  looksLikeBackdropColour,
  looksLikeSecondaryGarment,
  looksLikeGround,
  dropLeftoverBackdropIslands
} from "../src/mask-recover.js";
import {readPng} from "./helpers/png.js";
import { refineForegroundAlpha } from "../src/mask-refine.js";
import {
  JACKET,
  buildJacketScene,
  buildJacketCoarseAlpha,
  buildFullBleedJacket,
  buildFullBleedCoarseAlpha,
  buildLitJacketScene,
  buildLitJacketShadowWipe,
  buildTwoToneJacket,
  buildTwoToneCoarseAlpha,
  buildWrinkledTwoToneJacket,
  buildJacketOnGrassAndWhiteRug,
  buildJacketWithTanLeftovers,
  buildTanLeftoverAlpha,
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

test("a navy collar deleted next to a cyan body is restored, carpet stays gone", async () => {
  const scene = buildTwoToneJacket();
  const { rgb, truth, width, height, collar } = scene;
  const coarse = buildTwoToneCoarseAlpha(scene);
  assert.equal(regionStats(coarse, width, collar).share, 0, "the fixture starts with the navy panel gone");

  const panels = restoreNonBackgroundPanels(rgb, coarse, width, height);
  assert.ok(regionStats(panels.alpha, width, collar).share > 0.9, "the navy panel must come back as its own colour");

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });
  assert.ok(regionStats(alpha, width, collar).share > 0.9, "refine must keep the navy collar");
  assert.ok(subjectRetention(alpha, truth) > 0.94, `jacket retained ${subjectRetention(alpha, truth)}`);
  assert.ok(backgroundLeftover(alpha, truth) < 0.1, `carpet leftover ${backgroundLeftover(alpha, truth)}`);
});

test("wrinkled navy that touches the frame is restored and green pile stays gone", async () => {
  const scene = buildWrinkledTwoToneJacket();
  const { rgb, truth, width, height, collar } = scene;
  const coarse = buildTwoToneCoarseAlpha(scene);
  assert.equal(regionStats(coarse, width, collar).share, 0);

  const seed = cornerBackgroundSeed(rgb, width, height);
  assert.ok(seed, "top corners still contain carpet");
  assert.ok(seed.colour[1] > seed.colour[2] + 8, "the seed must stay green, not a navy+carpet blend");

  const recovered = recoverDeletedSubject(rgb, coarse, width, height);
  assert.ok(regionStats(recovered.alpha, width, collar).share > 0.85, "wrinkled navy yoke must come back");

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });
  assert.ok(regionStats(alpha, width, collar).share > 0.85, "refine must keep the wrinkled navy");
  assert.ok(subjectRetention(alpha, truth) > 0.9, `jacket retained ${subjectRetention(alpha, truth)}`);
  assert.ok(backgroundLeftover(alpha, truth) < 0.12, `carpet leftover ${backgroundLeftover(alpha, truth)}`);
});

test("the real jacket close-up keeps navy shoulders and drops the green carpet", async () => {
  const { width, height, rgb } = await readPng(new URL("./fixtures/jacket-grass-closeup.png", import.meta.url));
  const classify = (r, g, b) => {
    const max = Math.max(r, g, b);
    const greenLead = g - Math.max(r, b);
    if (greenLead > 18 && g > 55) return "carpet";
    if (b > r + 35 && g > r + 15 && b > 90 && r < 140) return "cyan";
    if (max < 110 && b + 8 >= g && r < g + 18 && greenLead < 12) return "navy";
    if (max < 70) return "navy";
    return "other";
  };

  const seed = cornerBackgroundSeed(rgb, width, height);
  assert.ok(seed, "the close-up has green in the top corners");
  assert.equal(looksLikeBackdropColour(42, 56, 71, seed, 42), false, "mean navy must not look like carpet");
  assert.equal(looksLikeBackdropColour(42, 95, 60, seed, 42), true, "green pile must still look like carpet");

  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (classify(rgb[o], rgb[o + 1], rgb[o + 2]) === "cyan") alpha[i] = 255;
  }

  const recovered = recoverDeletedSubject(rgb, alpha, width, height);
  const { alpha: refined } = await refineForegroundAlpha({ rgb, alpha, width, height });
  const score = (mask) => {
    const counts = { navy: { n: 0, kept: 0 }, carpet: { n: 0, kept: 0 }, cyan: { n: 0, kept: 0 } };
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const kind = classify(rgb[o], rgb[o + 1], rgb[o + 2]);
      if (!counts[kind]) continue;
      counts[kind].n++;
      if (mask[i] > 180) counts[kind].kept++;
    }
    return {
      navy: counts.navy.kept / counts.navy.n,
      carpet: counts.carpet.kept / counts.carpet.n,
      cyan: counts.cyan.kept / counts.cyan.n
    };
  };
  const recoveredScore = score(recovered.alpha);
  const refinedScore = score(refined);
  assert.ok(recoveredScore.navy > 0.8, `recovered navy ${recoveredScore.navy}`);
  assert.ok(recoveredScore.carpet < 0.15, `recovered carpet ${recoveredScore.carpet}`);
  assert.ok(refinedScore.navy > 0.78, `refined navy ${refinedScore.navy}`);
  assert.ok(refinedScore.carpet < 0.18, `refined carpet ${refinedScore.carpet}`);
  assert.ok(refinedScore.cyan > 0.95, `refined cyan ${refinedScore.cyan}`);
});

test("a white rug touching the sleeve is not restored with the navy yoke", async () => {
  const scene = buildJacketOnGrassAndWhiteRug();
  const { rgb, truth, width, height, collar, rug } = scene;
  const coarse = buildTwoToneCoarseAlpha(scene);
  assert.equal(looksLikeSecondaryGarment(20, 28, 58), true, "navy is a garment panel");
  assert.equal(looksLikeSecondaryGarment(214, 210, 204), false, "white pile is not a garment panel");
  assert.equal(looksLikeBackdropColour(214, 210, 204, cornerBackgroundSeed(rgb, width, height), 42), true);

  const recovered = recoverDeletedSubject(rgb, coarse, width, height);
  assert.ok(regionStats(recovered.alpha, width, collar).share > 0.85, "navy yoke must still come back");
  assert.ok(regionStats(recovered.alpha, width, rug).share < 0.08, "the letter rug must stay gone");

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });
  assert.ok(regionStats(alpha, width, collar).share > 0.85, "refine must keep navy");
  assert.ok(regionStats(alpha, width, rug).share < 0.1, `rug leftover ${regionStats(alpha, width, rug).share}`);
  assert.ok(subjectRetention(alpha, truth) > 0.9);
  assert.ok(backgroundLeftover(alpha, truth) < 0.12);
});

test("tan leftover ground is backdrop, not navy fabric", () => {
  assert.equal(looksLikeGround(176, 164, 146), true);
  assert.equal(looksLikeGround(168, 166, 162), true);
  assert.equal(looksLikeGround(42, 56, 71), false);
  assert.equal(looksLikeGround(10, 168, 226), false);
  assert.equal(looksLikeSecondaryGarment(176, 164, 146), false);
});

test("isolated tan leftover islands around the jacket are dropped", async () => {
  const scene = buildJacketWithTanLeftovers();
  const { rgb, truth, width, height, left, right, collar } = scene;
  const coarse = buildTanLeftoverAlpha(scene);
  assert.ok(regionStats(coarse, width, left).share > 0.9, "the fixture starts with leftover tan");

  const dropped = dropLeftoverBackdropIslands(rgb, coarse, width, height);
  assert.ok(regionStats(dropped.alpha, width, left).share < 0.08, "left tan island must go");
  assert.ok(regionStats(dropped.alpha, width, right).share < 0.08, "right tan island must go");

  const recovered = recoverDeletedSubject(rgb, coarse, width, height);
  assert.ok(regionStats(recovered.alpha, width, collar).share > 0.85, "navy yoke must still come back");
  assert.ok(regionStats(recovered.alpha, width, left).share < 0.08, "recovery must drop leftover tan");

  const { alpha } = await refineForegroundAlpha({ rgb, alpha: coarse, width, height });
  assert.ok(regionStats(alpha, width, left).share < 0.08, "refine must drop leftover tan");
  assert.ok(regionStats(alpha, width, right).share < 0.08);
  assert.ok(regionStats(alpha, width, collar).share > 0.85, "refine must keep navy");
  assert.ok(subjectRetention(alpha, truth) > 0.9);
  assert.ok(backgroundLeftover(alpha, truth) < 0.12);
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
