/*
 * Target-guided cutout correction ("AI Assist").
 *
 * A tap selects the whole connected colour chunk under the target — the navy
 * collar, the leftover carpet — the way PhotoRoom does. The visible circle is
 * only the picker: it decides which colour you meant. Growth then follows that
 * colour across the photo and stops at a different colour.
 *
 * Restore only paints missing pixels of that chunk back from the original.
 * Erase only removes pixels of that chunk that are still in the cutout.
 */

import { guidedFilterColour } from "./mask-refine.js";

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

function colourDistance(r, g, b, r2, g2, b2) {
  return Math.hypot(r - r2, g - g2, b - b2);
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

  const tolerance = options.maxTolerance ?? 46;
  const total = width * height;
  const inChunk = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const seedRadius = Math.max(1.5, targetRadius * (options.seedShare ?? 0.45));
  for (let py = Math.max(0, centreY - Math.ceil(seedRadius)); py <= Math.min(height - 1, centreY + Math.ceil(seedRadius)); py++) {
    for (let px = Math.max(0, centreX - Math.ceil(seedRadius)); px <= Math.min(width - 1, centreX + Math.ceil(seedRadius)); px++) {
      if ((px - centreX) * (px - centreX) + (py - centreY) * (py - centreY) > seedRadius * seedRadius) continue;
      const i = py * width + px;
      const o = i * 4;
      if (colourDistance(rgb[o], rgb[o + 1], rgb[o + 2], seed.r, seed.g, seed.b) > tolerance) continue;
      if (inChunk[i]) continue;
      inChunk[i] = 1;
      queue[tail++] = i;
    }
  }
  if (!tail) return null;

  while (head < tail) {
    const i = queue[head++];
    const cx = i % width;
    const consider = index => {
      if (index < 0 || index >= total || inChunk[index]) return;
      const o = index * 4;
      if (colourDistance(rgb[o], rgb[o + 1], rgb[o + 2], seed.r, seed.g, seed.b) > tolerance) return;
      inChunk[index] = 1;
      queue[tail++] = index;
    };
    if (cx > 0) consider(i - 1);
    if (cx < width - 1) consider(i + 1);
    if (i >= width) consider(i - width);
    if (i < total - width) consider(i + width);
  }

  let minX = width, maxX = -1, minY = height, maxY = -1;
  let accepted = 0;
  const changeable = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!inChunk[i]) continue;
    const canChange = mode === "erase" ? alpha[i] > 40 : alpha[i] < 220;
    if (!canChange) continue;
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
  const channels = {
    r: new Float32Array(boxWidth * boxHeight),
    g: new Float32Array(boxWidth * boxHeight),
    b: new Float32Array(boxWidth * boxHeight)
  };
  for (let by = 0; by < boxHeight; by++) {
    for (let bx = 0; bx < boxWidth; bx++) {
      const i = by * boxWidth + bx;
      const src = (y0 + by) * width + x0 + bx;
      const o = src * 4;
      channels.r[i] = rgb[o] / 255;
      channels.g[i] = rgb[o + 1] / 255;
      channels.b[i] = rgb[o + 2] / 255;
      weights[i] = changeable[src] ? 1 : 0;
    }
  }

  const blurRadius = Math.max(1, Math.round(Math.min(boxWidth, boxHeight) * 0.012) || 1);
  let smoothed = boxBlurWeights(weights, boxWidth, boxHeight, blurRadius);
  smoothed = guidedFilterColour(channels, smoothed, boxWidth, boxHeight, Math.max(2, blurRadius * 2), options.guideEps ?? 4e-4);
  for (let i = 0; i < smoothed.length; i++) {
    const value = smoothed[i];
    smoothed[i] = value < 0.04 ? 0 : Math.min(1, value);
  }

  return {
    x0,
    y0,
    width: boxWidth,
    height: boxHeight,
    weights: smoothed,
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
