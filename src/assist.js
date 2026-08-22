/*
 * Target-guided cutout correction ("AI Assist").
 *
 * The circle only picks which colour you meant. Growth then fills the one
 * connected patch under the tap — the leftover green you clicked, or the
 * navy panel you clicked — and stops at a different colour. Two green
 * corners stay two patches. Erasing the jacket must not take the carpet.
 */

import { isGreenDominant, looksLikeBrightNeutral, looksLikeSecondaryGarment } from "./mask-recover.js";

function colourDistance(r, g, b, r2, g2, b2) {
  return Math.hypot(r - r2, g - g2, b - b2);
}

export function colourFamily(r, g, b) {
  if (isGreenDominant(r, g, b) || (g - Math.max(r, b) > 16 && g >= 50)) return "green";
  if (looksLikeBrightNeutral(r, g, b)) return "white";
  if (b > r + 30 && g > r + 8 && b > 80) return "cyan";
  if (looksLikeSecondaryGarment(r, g, b)) return "navy";
  return "other";
}

function isBackdropFamily(family) {
  return family === "green" || family === "white";
}

function sampleSeedColour(rgb, width, height, cx, cy, radius, options) {
  const seedRadius = Math.max(1.5, radius * (options.seedShare ?? 0.45));
  const bins = new Map();
  const samples = [];
  const x0 = Math.max(0, Math.floor(cx - seedRadius));
  const x1 = Math.min(width - 1, Math.ceil(cx + seedRadius));
  const y0 = Math.max(0, Math.floor(cy - seedRadius));
  const y1 = Math.min(height - 1, Math.ceil(cy + seedRadius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > seedRadius * seedRadius) continue;
      const o = (y * width + x) * 4;
      const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      samples.push(r, g, b);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let entry = bins.get(key);
      if (!entry) {
        entry = { n: 0, r: 0, g: 0, b: 0 };
        bins.set(key, entry);
      }
      entry.n++;
      entry.r += r;
      entry.g += g;
      entry.b += b;
    }
  }
  if (!samples.length) return null;
  let dominant = null;
  for (const entry of bins.values()) if (!dominant || entry.n > dominant.n) dominant = entry;
  const modeR = dominant.r / dominant.n;
  const modeG = dominant.g / dominant.n;
  const modeB = dominant.b / dominant.n;
  const inlier = options.seedInlierDistance ?? 44;
  let seedR = 0, seedG = 0, seedB = 0, seedCount = 0;
  for (let s = 0; s < samples.length; s += 3) {
    if (colourDistance(samples[s], samples[s + 1], samples[s + 2], modeR, modeG, modeB) > inlier) continue;
    seedR += samples[s];
    seedG += samples[s + 1];
    seedB += samples[s + 2];
    seedCount++;
  }
  if (!seedCount) return { r: modeR, g: modeG, b: modeB };
  return { r: seedR / seedCount, g: seedG / seedCount, b: seedB / seedCount };
}

function canChange(alpha, index, mode) {
  return mode === "erase" ? alpha[index] > 40 : alpha[index] < 220;
}

/**
 * @returns {null | {x0:number, y0:number, width:number, height:number,
 *                   weights:Float32Array, accepted:number, coverage:number}}
 */
export function computeAssistSelection({ rgb, alpha, width, height, x, y, radius, mode = "erase", options = {} }) {
  const centreX = Math.round(Math.min(width - 1, Math.max(0, x)));
  const centreY = Math.round(Math.min(height - 1, Math.max(0, y)));
  const targetRadius = Math.max(3, radius);
  const seed = sampleSeedColour(rgb, width, height, centreX, centreY, targetRadius, options);
  if (!seed) return null;

  const family = colourFamily(seed.r, seed.g, seed.b);
  const stepLimit = options.stepLimit ?? 32;
  const total = width * height;
  const inChunk = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  // Only the tap starts the flood. The circle must not seed both leftover
  // green corners at once.
  const startRadius = Math.max(1.5, Math.min(4, targetRadius * 0.2));
  for (let py = Math.max(0, centreY - 4); py <= Math.min(height - 1, centreY + 4); py++) {
    for (let px = Math.max(0, centreX - 4); px <= Math.min(width - 1, centreX + 4); px++) {
      if ((px - centreX) * (px - centreX) + (py - centreY) * (py - centreY) > startRadius * startRadius) continue;
      const i = py * width + px;
      if (!canChange(alpha, i, mode)) continue;
      const o = i * 4;
      if (colourFamily(rgb[o], rgb[o + 1], rgb[o + 2]) !== family) continue;
      if (inChunk[i]) continue;
      inChunk[i] = 1;
      queue[tail++] = i;
    }
  }
  if (!tail) return null;

  const maxReach = isBackdropFamily(family)
    ? Math.max(40, Math.round(Math.min(width, height) * (options.backdropReach ?? 0.28)))
    : Infinity;

  while (head < tail) {
    const i = queue[head++];
    const cx = i % width;
    const cy = (i / width) | 0;
    const fo = i * 4;
    const consider = index => {
      if (index < 0 || index >= total || inChunk[index]) return;
      if (!canChange(alpha, index, mode)) return;
      const o = index * 4;
      if (colourFamily(rgb[o], rgb[o + 1], rgb[o + 2]) !== family) return;
      const toNeighbor = colourDistance(rgb[o], rgb[o + 1], rgb[o + 2], rgb[fo], rgb[fo + 1], rgb[fo + 2]);
      if (toNeighbor > stepLimit) return;
      if (maxReach !== Infinity) {
        const nx = index % width;
        const ny = (index / width) | 0;
        if (Math.hypot(nx - centreX, ny - centreY) > maxReach) return;
      }
      inChunk[index] = 1;
      queue[tail++] = index;
    };
    if (cx > 0) consider(i - 1);
    if (cx < width - 1) consider(i + 1);
    if (cy > 0) consider(i - width);
    if (cy < height - 1) consider(i + width);
  }

  let minX = width, maxX = -1, minY = height, maxY = -1;
  let accepted = 0;
  const changeable = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!inChunk[i]) continue;
    changeable[i] = 1;
    accepted++;
    const px = i % width;
    const py = (i / width) | 0;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  if (accepted < 3 || maxX < 0) return null;

  const pad = 2;
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(width - 1, maxX + pad);
  const y1 = Math.min(height - 1, maxY + pad);
  const boxWidth = x1 - x0 + 1;
  const boxHeight = y1 - y0 + 1;
  const weights = new Float32Array(boxWidth * boxHeight);
  for (let by = 0; by < boxHeight; by++) {
    for (let bx = 0; bx < boxWidth; bx++) {
      const src = (y0 + by) * width + x0 + bx;
      weights[by * boxWidth + bx] = changeable[src] ? 1 : 0;
    }
  }

  return {
    x0,
    y0,
    width: boxWidth,
    height: boxHeight,
    weights,
    accepted,
    coverage: accepted / Math.max(1, tail)
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
      } else if (weight >= 0.5) {
        pixels[o] = originalPixels[o];
        pixels[o + 1] = originalPixels[o + 1];
        pixels[o + 2] = originalPixels[o + 2];
        if (pixels[o + 3] < 255) {
          pixels[o + 3] = 255;
          changed++;
        }
      }
    }
  }
  return changed;
}
