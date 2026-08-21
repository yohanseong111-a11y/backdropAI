/*
 * Target-guided cutout correction ("AI Assist").
 *
 * The user places a circular target and the tool works out which nearby pixels
 * belong to the thing under that target. Three rules keep it predictable:
 *
 *   1. Nothing outside the visible target circle can ever change.
 *   2. Growth is connected from the target centre, so a tap cannot affect a
 *      distant part of the photo.
 *   3. Growth stops at real image edges and at colours that match the surrounding
 *      subject, so a tap next to the subject trims the background instead of
 *      biting a hole into the person.
 *
 * The resulting weight map is blurred and edge-aligned, so corrections look like
 * segmentation changes rather than circular eraser stamps.
 */

import { guidedFilterColour } from "./mask-refine.js";
import { insideBrushFootprint } from "./mask-safety.js";

const SUBJECT_LEVEL = 250;

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function boxBlurWeights(weights, width, height, radius) {
  if (radius < 1) return weights;
  const horizontal = new Float32Array(weights.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let ox = -radius; ox <= radius; ox++) {
        const nx = x + ox;
        if (nx < 0 || nx >= width) continue;
        sum += weights[row + nx];
        count++;
      }
      horizontal[row + x] = sum / (count || span);
    }
  }
  const out = new Float32Array(weights.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let oy = -radius; oy <= radius; oy++) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        sum += horizontal[ny * width + x];
        count++;
      }
      out[y * width + x] = sum / (count || span);
    }
  }
  return out;
}

function packReferenceClusters(samples, maxClusters) {
  const ranked = [...samples.values()].sort((a, b) => b.n - a.n).slice(0, maxClusters);
  const packed = new Float32Array(ranked.length * 3);
  ranked.forEach((entry, index) => {
    packed[index * 3] = entry.r / entry.n;
    packed[index * 3 + 1] = entry.g / entry.n;
    packed[index * 3 + 2] = entry.b / entry.n;
  });
  return packed;
}

function nearestDistance(clusters, r, g, b) {
  if (!clusters.length) return Infinity;
  let best = Infinity;
  for (let k = 0; k < clusters.length; k += 3) {
    const dr = r - clusters[k];
    const dg = g - clusters[k + 1];
    const db = b - clusters[k + 2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < best) best = distance;
  }
  return Math.sqrt(best);
}

/**
 * @returns {null | {x0:number, y0:number, width:number, height:number,
 *                   weights:Float32Array, accepted:number, coverage:number}}
 *          `weights` is 0…1 per pixel of the returned window.
 */
export function computeAssistSelection({ rgb, alpha, width, height, x, y, radius, mode = "erase", options = {} }) {
  const centreX = Math.round(Math.min(width - 1, Math.max(0, x)));
  const centreY = Math.round(Math.min(height - 1, Math.max(0, y)));
  const targetRadius = Math.max(3, radius);
  const reach = Math.ceil(targetRadius);

  const x0 = Math.max(0, centreX - reach);
  const y0 = Math.max(0, centreY - reach);
  const x1 = Math.min(width - 1, centreX + reach);
  const y1 = Math.min(height - 1, centreY + reach);
  const boxWidth = x1 - x0 + 1;
  const boxHeight = y1 - y0 + 1;
  if (boxWidth < 3 || boxHeight < 3) return null;
  const boxTotal = boxWidth * boxHeight;

  const luma = new Float32Array(boxTotal);
  const channels = {
    r: new Float32Array(boxTotal),
    g: new Float32Array(boxTotal),
    b: new Float32Array(boxTotal)
  };
  for (let by = 0; by < boxHeight; by++) {
    for (let bx = 0; bx < boxWidth; bx++) {
      const o = ((y0 + by) * width + x0 + bx) * 4;
      const i = by * boxWidth + bx;
      channels.r[i] = rgb[o] / 255;
      channels.g[i] = rgb[o + 1] / 255;
      channels.b[i] = rgb[o + 2] / 255;
      luma[i] = (rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114) / 255;
    }
  }

  // Colour gradient, not luma: two equally bright colours still form a boundary.
  const gradient = new Float32Array(boxTotal);
  for (let by = 1; by < boxHeight - 1; by++) {
    for (let bx = 1; bx < boxWidth - 1; bx++) {
      const i = by * boxWidth + bx;
      let strongest = 0;
      for (const field of [channels.r, channels.g, channels.b]) {
        const gx = field[i + 1] - field[i - 1];
        const gy = field[i + boxWidth] - field[i - boxWidth];
        const magnitude = Math.hypot(gx, gy);
        if (magnitude > strongest) strongest = magnitude;
      }
      gradient[i] = Math.min(1, strongest * 2);
    }
  }

  // 1. Learn the colour under the target from a small central disc.
  //
  // The average of that disc is not good enough: a target placed just outside the
  // subject also covers a slice of it, and an averaged seed sits between the two
  // colours with a huge spread — which used to widen the tolerance and let a
  // single tap swallow part of the subject. So take the dominant colour of the
  // disc and measure the spread only over pixels that agree with it.
  const seedRadius = Math.max(1.5, targetRadius * (options.seedShare ?? 0.22));
  const discSamples = [];
  const discBins = new Map();
  for (let by = 0; by < boxHeight; by++) {
    const dy = y0 + by - centreY;
    for (let bx = 0; bx < boxWidth; bx++) {
      const dx = x0 + bx - centreX;
      if (dx * dx + dy * dy > seedRadius * seedRadius) continue;
      const o = ((y0 + by) * width + x0 + bx) * 4;
      const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      discSamples.push(r, g, b);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let entry = discBins.get(key);
      if (!entry) {
        entry = { n: 0, r: 0, g: 0, b: 0 };
        discBins.set(key, entry);
      }
      entry.n++;
      entry.r += r;
      entry.g += g;
      entry.b += b;
    }
  }
  if (!discSamples.length) return null;

  let dominant = null;
  for (const entry of discBins.values()) if (!dominant || entry.n > dominant.n) dominant = entry;
  const modeR = dominant.r / dominant.n;
  const modeG = dominant.g / dominant.n;
  const modeB = dominant.b / dominant.n;

  const inlierLimit = options.seedInlierDistance ?? 44;
  let seedR = 0, seedG = 0, seedB = 0, seedCount = 0;
  for (let s = 0; s < discSamples.length; s += 3) {
    if (Math.hypot(discSamples[s] - modeR, discSamples[s + 1] - modeG, discSamples[s + 2] - modeB) > inlierLimit) continue;
    seedR += discSamples[s];
    seedG += discSamples[s + 1];
    seedB += discSamples[s + 2];
    seedCount++;
  }
  if (!seedCount) {
    seedR = modeR; seedG = modeG; seedB = modeB; seedCount = 1;
  } else {
    seedR /= seedCount;
    seedG /= seedCount;
    seedB /= seedCount;
  }

  let spread = 0;
  let spreadCount = 0;
  for (let s = 0; s < discSamples.length; s += 3) {
    const distance = Math.hypot(discSamples[s] - seedR, discSamples[s + 1] - seedG, discSamples[s + 2] - seedB);
    if (distance > inlierLimit) continue;
    spread += distance;
    spreadCount++;
  }
  spread = spreadCount ? spread / spreadCount : 0;

  const tolerance = Math.min(
    options.maxTolerance ?? 62,
    Math.max(options.minTolerance ?? 20, (options.baseTolerance ?? 22) + spread * 1.6)
  );

  // 2. Learn what the surrounding subject looks like, so growth can be refused when
  //    it starts to resemble the thing the user wants to keep.
  const keepLevel = mode === "erase" ? SUBJECT_LEVEL : 6;
  const protectSamples = new Map();
  for (let by = 0; by < boxHeight; by++) {
    const dy = y0 + by - centreY;
    for (let bx = 0; bx < boxWidth; bx++) {
      const dx = x0 + bx - centreX;
      const distance = Math.hypot(dx, dy);
      if (distance < targetRadius * 0.45 || distance > targetRadius * 1.05) continue;
      const index = (y0 + by) * width + x0 + bx;
      const isKeeper = mode === "erase" ? alpha[index] >= keepLevel : alpha[index] <= keepLevel;
      if (!isKeeper) continue;
      const o = index * 4;
      if (Math.hypot(rgb[o] - seedR, rgb[o + 1] - seedG, rgb[o + 2] - seedB) < tolerance * 1.25) continue;
      const key = ((rgb[o] >> 4) << 8) | ((rgb[o + 1] >> 4) << 4) | (rgb[o + 2] >> 4);
      let entry = protectSamples.get(key);
      if (!entry) {
        entry = { n: 0, r: 0, g: 0, b: 0 };
        protectSamples.set(key, entry);
      }
      entry.n++;
      entry.r += rgb[o];
      entry.g += rgb[o + 1];
      entry.b += rgb[o + 2];
    }
  }
  const protectClusters = packReferenceClusters(protectSamples, options.maxProtectClusters ?? 5);

  // 3. Connected growth from the target centre, clamped to the visible circle.
  const weights = new Float32Array(boxTotal);
  const visited = new Uint8Array(boxTotal);
  const queue = new Int32Array(boxTotal);
  const edgeLimit = options.edgeLimit ?? 0.24;
  const stepLimit = options.stepLimit ?? 0.14;
  let head = 0;
  let tail = 0;
  let accepted = 0;

  const seedIndex = (centreY - y0) * boxWidth + (centreX - x0);
  visited[seedIndex] = 1;
  queue[tail++] = seedIndex;
  weights[seedIndex] = 1;
  accepted++;

  while (head < tail) {
    const current = queue[head++];
    const cx = current % boxWidth;
    const cy = (current / boxWidth) | 0;
    const currentLuma = luma[current];

    const consider = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= boxWidth || ny >= boxHeight) return;
      const next = ny * boxWidth + nx;
      // Only accepted pixels are marked, so a pixel refused because of a hard step
      // from one side can still be reached along a smoother path.
      if (visited[next]) return;

      // Hard guarantee: nothing outside the visible target circle can change.
      if (!insideBrushFootprint(x0 + nx, y0 + ny, centreX, centreY, targetRadius)) return;

      // Do not step across a hard boundary: that is where one object ends.
      if (Math.abs(luma[next] - currentLuma) > stepLimit && gradient[next] > edgeLimit) return;

      const index = (y0 + ny) * width + x0 + nx;
      const o = index * 4;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];
      const toSeed = Math.hypot(r - seedR, g - seedG, b - seedB);

      // Pixels the mask already treats as the opposite class are easier to accept;
      // confident subject pixels have to look convincingly like the target.
      const alreadyLoose = mode === "erase" ? alpha[index] < 200 : alpha[index] > 60;
      const localTolerance = tolerance * (alreadyLoose ? 1.18 : 1);
      if (toSeed > localTolerance) return;

      const toProtected = nearestDistance(protectClusters, r, g, b);
      if (toProtected < toSeed * (options.protectRatio ?? 1)) return;

      visited[next] = 1;
      weights[next] = 1;
      accepted++;
      queue[tail++] = next;
    };

    consider(cx - 1, cy);
    consider(cx + 1, cy);
    consider(cx, cy - 1);
    consider(cx, cy + 1);
  }

  const discArea = Math.PI * targetRadius * targetRadius;
  if (accepted < 3) return null;

  // 4. Soften: blur, snap to image edges, then fade out at the target rim so the
  //    correction never leaves a hard circular cut.
  const blurRadius = Math.max(1, Math.round(targetRadius * (options.blurShare ?? 0.08)));
  let smoothed = boxBlurWeights(weights, boxWidth, boxHeight, blurRadius);
  smoothed = guidedFilterColour(channels, smoothed, boxWidth, boxHeight, Math.max(2, blurRadius * 2), options.guideEps ?? 4e-4);

  const fadeStart = targetRadius * (options.fadeStart ?? 0.84);
  for (let by = 0; by < boxHeight; by++) {
    const dy = y0 + by - centreY;
    for (let bx = 0; bx < boxWidth; bx++) {
      const dx = x0 + bx - centreX;
      const index = by * boxWidth + bx;
      const distance = Math.hypot(dx, dy);
      const fade = distance <= fadeStart ? 1 : 1 - smoothstep(fadeStart, targetRadius, distance);
      const value = smoothed[index] * fade;
      smoothed[index] = value < 0.02 ? 0 : Math.min(1, value);
    }
  }

  return {
    x0,
    y0,
    width: boxWidth,
    height: boxHeight,
    weights: smoothed,
    accepted,
    coverage: accepted / discArea
  };
}

/**
 * Apply a selection to RGBA pixel data in place.
 * Erase lowers alpha; restore raises it back toward the untouched original.
 */
export function applyAssistSelection(pixels, originalPixels, width, selection, mode) {
  if (!selection) return 0;
  let changed = 0;
  for (let by = 0; by < selection.height; by++) {
    for (let bx = 0; bx < selection.width; bx++) {
      const weight = selection.weights[by * selection.width + bx];
      if (weight <= 0) continue;
      const index = (selection.y0 + by) * width + selection.x0 + bx;
      const o = index * 4;
      if (mode === "erase") {
        const next = Math.round(pixels[o + 3] * (1 - weight));
        if (next < pixels[o + 3]) {
          pixels[o + 3] = next;
          changed++;
        }
      } else {
        const target = Math.round(originalPixels[o + 3] * weight);
        if (target > pixels[o + 3]) {
          const mix = weight;
          pixels[o] = Math.round(pixels[o] * (1 - mix) + originalPixels[o] * mix);
          pixels[o + 1] = Math.round(pixels[o + 1] * (1 - mix) + originalPixels[o + 1] * mix);
          pixels[o + 2] = Math.round(pixels[o + 2] * (1 - mix) + originalPixels[o + 2] * mix);
          pixels[o + 3] = Math.max(pixels[o + 3], target);
          changed++;
        }
      }
    }
  }
  return changed;
}
