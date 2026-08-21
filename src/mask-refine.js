/*
 * Post-processing for segmentation masks.
 *
 * Inference runs on a small square (256–1024 px) while phone photos are 12–48 MP,
 * so a plain upscale leaves soft blobby edges, a halo of original background around
 * the subject and filled-in gaps such as the space between two legs. Everything here
 * works on the mask at a mid-size "working resolution" together with the matching
 * RGB pixels, so the mask can be snapped back onto real image edges before it is
 * applied to the full-resolution photo.
 *
 * Every stage is preservation-biased: it must prove a pixel is background before
 * deleting it, and the orchestrator rolls a stage back when the subject shrinks.
 */

const UNKNOWN_DISTANCE = 999;

export function buildIntegral(src, width, height, out) {
  const stride = width + 1;
  out.fill(0, 0, stride);
  for (let y = 0; y < height; y++) {
    const row = (y + 1) * stride;
    const previous = y * stride;
    let running = 0;
    out[row] = 0;
    for (let x = 0; x < width; x++) {
      running += src[y * width + x];
      out[row + x + 1] = out[previous + x + 1] + running;
    }
  }
  return out;
}

export function boxMean(src, width, height, radius, out, integral) {
  const stride = width + 1;
  buildIntegral(src, width, height, integral);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    const top = y0 * stride;
    const bottom = (y1 + 1) * stride;
    const rows = y1 - y0 + 1;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum = integral[bottom + x1 + 1] - integral[bottom + x0] - integral[top + x1 + 1] + integral[top + x0];
      out[y * width + x] = sum / ((x1 - x0 + 1) * rows);
    }
  }
  return out;
}

/**
 * Edge-aware smoothing of `target` using `guide` (He et al. guided filter).
 * This is what pulls a low-resolution matte back onto the real photo edges.
 */
export function guidedFilter(guide, target, width, height, radius, eps) {
  const total = width * height;
  const integral = new Float64Array((width + 1) * (height + 1));
  const meanGuide = new Float32Array(total);
  const meanTarget = new Float32Array(total);
  const scratch = new Float32Array(total);
  const corrGuide = new Float32Array(total);
  const corrCross = new Float32Array(total);

  boxMean(guide, width, height, radius, meanGuide, integral);
  boxMean(target, width, height, radius, meanTarget, integral);
  for (let i = 0; i < total; i++) scratch[i] = guide[i] * guide[i];
  boxMean(scratch, width, height, radius, corrGuide, integral);
  for (let i = 0; i < total; i++) scratch[i] = guide[i] * target[i];
  boxMean(scratch, width, height, radius, corrCross, integral);

  const slope = new Float32Array(total);
  const offset = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const variance = corrGuide[i] - meanGuide[i] * meanGuide[i];
    const covariance = corrCross[i] - meanGuide[i] * meanTarget[i];
    const a = covariance / (variance + eps);
    slope[i] = a;
    offset[i] = meanTarget[i] - a * meanGuide[i];
  }

  boxMean(slope, width, height, radius, corrGuide, integral);
  boxMean(offset, width, height, radius, corrCross, integral);

  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    out[i] = Math.min(1, Math.max(0, corrGuide[i] * guide[i] + corrCross[i]));
  }
  return out;
}

export function colourChannels(rgb, width, height) {
  const total = width * height;
  const r = new Float32Array(total);
  const g = new Float32Array(total);
  const b = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    r[i] = rgb[o] / 255;
    g[i] = rgb[o + 1] / 255;
    b[i] = rgb[o + 2] / 255;
  }
  return { r, g, b };
}

/**
 * Colour version of the guided filter.
 *
 * The grayscale filter cannot see a boundary between two colours of the same
 * brightness — light denim against grey concrete is almost exactly isoluminant —
 * so the mask edge would stay blurred right where it matters. Using all three
 * channels as guidance recovers those edges.
 */
export function guidedFilterColour(channels, target, width, height, radius, eps) {
  const total = width * height;
  const integral = new Float64Array((width + 1) * (height + 1));
  const scratch = new Float32Array(total);
  const { r, g, b } = channels;

  const mean = source => {
    const out = new Float32Array(total);
    boxMean(source, width, height, radius, out, integral);
    return out;
  };
  const meanOfProduct = (x, y) => {
    for (let i = 0; i < total; i++) scratch[i] = x[i] * y[i];
    return mean(scratch);
  };

  const meanR = mean(r);
  const meanG = mean(g);
  const meanB = mean(b);
  const meanP = mean(target);

  const varRR = meanOfProduct(r, r);
  const varRG = meanOfProduct(r, g);
  const varRB = meanOfProduct(r, b);
  const varGG = meanOfProduct(g, g);
  const varGB = meanOfProduct(g, b);
  const varBB = meanOfProduct(b, b);
  const covPR = meanOfProduct(r, target);
  const covPG = meanOfProduct(g, target);
  const covPB = meanOfProduct(b, target);

  for (let i = 0; i < total; i++) {
    const a11 = varRR[i] - meanR[i] * meanR[i] + eps;
    const a12 = varRG[i] - meanR[i] * meanG[i];
    const a13 = varRB[i] - meanR[i] * meanB[i];
    const a22 = varGG[i] - meanG[i] * meanG[i] + eps;
    const a23 = varGB[i] - meanG[i] * meanB[i];
    const a33 = varBB[i] - meanB[i] * meanB[i] + eps;

    const c1 = a22 * a33 - a23 * a23;
    const c2 = a13 * a23 - a12 * a33;
    const c3 = a12 * a23 - a13 * a22;
    const det = a11 * c1 + a12 * c2 + a13 * c3;

    const pr = covPR[i] - meanR[i] * meanP[i];
    const pg = covPG[i] - meanG[i] * meanP[i];
    const pb = covPB[i] - meanB[i] * meanP[i];

    let ar = 0, ag = 0, ab = 0;
    if (Math.abs(det) > 1e-12) {
      const inv = 1 / det;
      ar = (c1 * pr + c2 * pg + c3 * pb) * inv;
      ag = (c2 * pr + (a11 * a33 - a13 * a13) * pg + (a13 * a12 - a11 * a23) * pb) * inv;
      ab = (c3 * pr + (a12 * a13 - a11 * a23) * pg + (a11 * a22 - a12 * a12) * pb) * inv;
    }
    // Reuse the covariance buffers for the coefficients to keep peak memory down.
    varRR[i] = ar;
    varRG[i] = ag;
    varRB[i] = ab;
    varGG[i] = meanP[i] - ar * meanR[i] - ag * meanG[i] - ab * meanB[i];
  }

  boxMean(varRR, width, height, radius, covPR, integral);
  boxMean(varRG, width, height, radius, covPG, integral);
  boxMean(varRB, width, height, radius, covPB, integral);
  boxMean(varGG, width, height, radius, varBB, integral);

  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const value = covPR[i] * r[i] + covPG[i] * g[i] + covPB[i] * b[i] + varBB[i];
    out[i] = value < 0 ? 0 : value > 1 ? 1 : value;
  }
  return out;
}

export function resampleAlpha(alpha, sourceWidth, sourceHeight, width, height) {
  if (sourceWidth === width && sourceHeight === height) return new Uint8Array(alpha);
  const out = new Uint8Array(width * height);
  const ratioX = sourceWidth / width;
  const ratioY = sourceHeight / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(sourceHeight - 1, Math.max(0, (y + 0.5) * ratioY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(sourceWidth - 1, Math.max(0, (x + 0.5) * ratioX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const fx = sx - x0;
      const topLeft = alpha[y0 * sourceWidth + x0];
      const topRight = alpha[y0 * sourceWidth + x1];
      const bottomLeft = alpha[y1 * sourceWidth + x0];
      const bottomRight = alpha[y1 * sourceWidth + x1];
      const top = topLeft + (topRight - topLeft) * fx;
      const bottom = bottomLeft + (bottomRight - bottomLeft) * fx;
      out[y * width + x] = Math.round(top + (bottom - top) * fy);
    }
  }
  return out;
}

export function luminanceField(rgb, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114) / 255;
  }
  return out;
}

/** Normalised Sobel magnitude. Used to stop background reclaim at real object outlines. */
export function edgeStrength(field, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = field[i - width - 1], t = field[i - width], tr = field[i - width + 1];
      const l = field[i - 1], r = field[i + 1];
      const bl = field[i + width - 1], b = field[i + width], br = field[i + width + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      out[i] = Math.min(1, Math.hypot(gx, gy) / 4);
    }
  }
  return out;
}

/**
 * Strongest Sobel response across the three colour channels. A luma-only edge map
 * misses boundaries between equally bright colours, which is exactly where a mask
 * needs to stop.
 */
export function colourEdgeStrength(channels, width, height) {
  const total = width * height;
  const out = edgeStrength(channels.r, width, height);
  for (const field of [channels.g, channels.b]) {
    const other = edgeStrength(field, width, height);
    for (let i = 0; i < total; i++) if (other[i] > out[i]) out[i] = other[i];
  }
  return out;
}

function mergeBins(target, source) {
  for (const [key, entry] of source) {
    let existing = target.get(key);
    if (!existing) {
      existing = { n: 0, r: 0, g: 0, b: 0 };
      target.set(key, existing);
    }
    existing.n += entry.n;
    existing.r += entry.r;
    existing.g += entry.g;
    existing.b += entry.b;
  }
  return target;
}

function packClusters(bins, maxClusters) {
  const ranked = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, maxClusters);
  const packed = new Float32Array(ranked.length * 3);
  const weights = new Float32Array(ranked.length);
  let samples = 0;
  ranked.forEach((entry, index) => {
    packed[index * 3] = entry.r / entry.n;
    packed[index * 3 + 1] = entry.g / entry.n;
    packed[index * 3 + 2] = entry.b / entry.n;
    weights[index] = entry.n;
    samples += entry.n;
  });
  return { clusters: packed, weights, samples };
}

/**
 * Drops foreground colours that also appear in well-supported background.
 *
 * A segmentation mask over-covers far more often than it under-covers: the halo
 * around the subject and a gap the model filled in are both labelled foreground
 * while actually being background. Left alone, that contamination teaches the
 * foreground model the background's own colour, and every later stage then treats
 * leftover background as subject. Proven background therefore wins ties.
 */
function discriminativeForeground(foreground, background, options = {}) {
  const ambiguity = options.ambiguityDistance ?? 26;
  const minShare = options.minBackgroundShare ?? 0.12;
  if (!foreground.clusters.length || !background.clusters.length || !background.samples) {
    return foreground.clusters;
  }

  const kept = [];
  for (let f = 0; f < foreground.clusters.length; f += 3) {
    const r = foreground.clusters[f];
    const g = foreground.clusters[f + 1];
    const b = foreground.clusters[f + 2];
    let shared = false;
    for (let k = 0; k < background.clusters.length; k += 3) {
      if (background.weights[k / 3] / background.samples < minShare) continue;
      const dr = r - background.clusters[k];
      const dg = g - background.clusters[k + 1];
      const db = b - background.clusters[k + 2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) < ambiguity) { shared = true; break; }
    }
    if (!shared) kept.push(r, g, b);
  }

  // Never end up with no foreground evidence at all: that would make the whole
  // subject look like background to the stages that follow.
  if (!kept.length) return foreground.clusters.slice(0, 3);
  return Float32Array.from(kept);
}

/**
 * Learn what foreground and background actually look like *near every part of the
 * image*. A global colour model confuses a navy garment with a dark floor; a local
 * model keeps the comparison meaningful. Cells widen their search ring, then fall
 * back to a global model, and the scope is reported so callers can be stricter when
 * the evidence came from far away.
 */
export function buildLocalColourModels(rgb, alpha, width, height, options = {}) {
  const cellSize = options.cellSize || Math.max(18, Math.round(Math.max(width, height) / 26));
  const cellsX = Math.max(1, Math.ceil(width / cellSize));
  const cellsY = Math.max(1, Math.ceil(height / cellSize));
  const cells = cellsX * cellsY;
  const maxClusters = options.maxClusters || 6;
  const minSamples = options.minSamples || 24;
  const foregroundLevel = options.foregroundLevel ?? 235;
  const backgroundLevel = options.backgroundLevel ?? 20;
  const stride = options.sampleStride || Math.max(1, Math.round(Math.max(width, height) / 640));

  const foregroundBins = Array.from({ length: cells }, () => new Map());
  const backgroundBins = Array.from({ length: cells }, () => new Map());

  for (let y = 0; y < height; y += stride) {
    const row = Math.min(cellsY - 1, (y / cellSize) | 0);
    for (let x = 0; x < width; x += stride) {
      const i = y * width + x;
      const a = alpha[i];
      let bins = null;
      if (a >= foregroundLevel) bins = foregroundBins[row * cellsX + Math.min(cellsX - 1, (x / cellSize) | 0)];
      else if (a <= backgroundLevel) bins = backgroundBins[row * cellsX + Math.min(cellsX - 1, (x / cellSize) | 0)];
      if (!bins) continue;
      const o = i * 4;
      const key = ((rgb[o] >> 4) << 8) | ((rgb[o + 1] >> 4) << 4) | (rgb[o + 2] >> 4);
      let entry = bins.get(key);
      if (!entry) {
        entry = { n: 0, r: 0, g: 0, b: 0 };
        bins.set(key, entry);
      }
      entry.n++;
      entry.r += rgb[o];
      entry.g += rgb[o + 1];
      entry.b += rgb[o + 2];
    }
  }

  const globalForeground = packClusters(foregroundBins.reduce((all, bins) => mergeBins(all, bins), new Map()), maxClusters);
  const globalBackground = packClusters(backgroundBins.reduce((all, bins) => mergeBins(all, bins), new Map()), maxClusters);

  const build = (bins, globalModel) => {
    const clusters = new Array(cells);
    const scope = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell++) {
      const col = cell % cellsX;
      const row = (cell / cellsX) | 0;
      let resolved = null;
      for (let ring = 0; ring <= 2 && !resolved; ring++) {
        const merged = new Map();
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            const nx = col + dx;
            const ny = row + dy;
            if (nx < 0 || ny < 0 || nx >= cellsX || ny >= cellsY) continue;
            mergeBins(merged, bins[ny * cellsX + nx]);
          }
        }
        const packed = packClusters(merged, maxClusters);
        if (packed.samples >= minSamples) {
          resolved = packed;
          scope[cell] = ring === 0 ? 0 : 1;
        }
      }
      if (!resolved) {
        resolved = globalModel;
        scope[cell] = 2;
      }
      clusters[cell] = resolved;
    }
    return { clusters, scope };
  };

  const foreground = build(foregroundBins, globalForeground);
  const background = build(backgroundBins, globalBackground);

  const foregroundClusters = new Array(cells);
  const backgroundClusters = new Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    foregroundClusters[cell] = discriminativeForeground(
      foreground.clusters[cell],
      background.clusters[cell],
      options.discriminative
    );
    backgroundClusters[cell] = background.clusters[cell].clusters;
  }

  return {
    cellsX,
    cellsY,
    cellSize,
    foreground: foregroundClusters,
    foregroundScope: foreground.scope,
    background: backgroundClusters,
    backgroundScope: background.scope,
    globalBackgroundSamples: globalBackground.samples,
    globalForegroundSamples: globalForeground.samples
  };
}

function nearestClusterDistance(clusters, r, g, b) {
  if (!clusters || !clusters.length) return UNKNOWN_DISTANCE;
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
 * Per-pixel colour distance to the nearest learned foreground / background colour,
 * plus how much the background evidence can be trusted (1 local … 0.62 global).
 */
export function colourDistanceMaps(rgb, models, width, height) {
  const total = width * height;
  const toForeground = new Float32Array(total);
  const toBackground = new Float32Array(total);
  const backgroundTrust = new Float32Array(total);
  const trustForScope = [1, 0.86, 0.62];

  for (let y = 0; y < height; y++) {
    const row = Math.min(models.cellsY - 1, (y / models.cellSize) | 0);
    for (let x = 0; x < width; x++) {
      const cell = row * models.cellsX + Math.min(models.cellsX - 1, (x / models.cellSize) | 0);
      const i = y * width + x;
      const o = i * 4;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];
      toForeground[i] = nearestClusterDistance(models.foreground[cell], r, g, b);
      toBackground[i] = nearestClusterDistance(models.background[cell], r, g, b);
      backgroundTrust[i] = trustForScope[models.backgroundScope[cell]] ?? 0.62;
    }
  }
  return { toForeground, toBackground, backgroundTrust };
}

/**
 * Grow the already-transparent region into pixels the mask kept but that clearly
 * belong to the background: leftover halo, fragments beside the subject and the
 * gaps a small mask filled in (between legs, between an arm and the body).
 *
 * Growth is connected — it always starts from proven background — and is stopped by
 * real image edges, so it cannot tunnel through the subject outline.
 */
export function reclaimConnectedBackground(alpha, distances, edges, width, height, options = {}) {
  const total = width * height;
  const backgroundTolerance = options.backgroundTolerance ?? 60;
  const separation = options.separation ?? 1.3;
  const edgeLimit = options.edgeLimit ?? 0.3;
  const seedLevel = options.seedLevel ?? 16;
  const { toForeground, toBackground, backgroundTrust } = distances;

  const out = new Uint8Array(alpha);
  const queue = new Int32Array(total);
  const seen = new Uint8Array(total);
  let head = 0;
  let tail = 0;
  let removed = 0;
  let evidenceSum = 0;

  for (let i = 0; i < total; i++) {
    if (alpha[i] <= seedLevel) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  if (!tail) return { alpha: out, removed: 0, evidence: 0 };

  const step = index => {
    if (seen[index]) return;
    seen[index] = 1;
    const background = toBackground[index];
    if (background > backgroundTolerance * backgroundTrust[index]) return;
    // The pixel has to look clearly more like background than like the subject.
    if (toForeground[index] < background * separation) return;
    if (edges[index] > edgeLimit) return;
    out[index] = 0;
    removed++;
    evidenceSum += toForeground[index] - background;
    queue[tail++] = index;
  };

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) step(i - 1);
    if (x < width - 1) step(i + 1);
    if (i >= width) step(i - width);
    if (i < total - width) step(i + width);
  }

  // How convincing the removal was on average. This matters more than how much
  // area was removed: a badly over-covered mask should lose a lot of area, as long
  // as every deleted pixel really did look like background.
  return { alpha: out, removed, evidence: removed ? evidenceSum / removed : 0 };
}

/**
 * Close holes the segmentation model punched inside the subject, but only when the
 * hole does not look like background. Enclosed background (a real gap) stays open.
 */
export function fillSubjectHoles(alpha, distances, width, height, options = {}) {
  const total = width * height;
  const holeLevel = options.holeLevel ?? 72;
  const maxShare = options.maxShare ?? 0.2;
  const { toForeground, toBackground } = distances;
  const out = new Uint8Array(alpha);

  const outside = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const flood = index => {
    if (index < 0 || index >= total || outside[index] || alpha[index] >= holeLevel) return;
    outside[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) {
    flood(x);
    flood((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    flood(y * width);
    flood(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) flood(i - 1);
    if (x < width - 1) flood(i + 1);
    if (i >= width) flood(i - width);
    if (i < total - width) flood(i + width);
  }

  const visited = new Uint8Array(total);
  let filled = 0;
  for (let start = 0; start < total; start++) {
    if (visited[start] || outside[start] || alpha[start] >= holeLevel) continue;
    head = 0;
    tail = 0;
    visited[start] = 1;
    queue[tail++] = start;
    const pixels = [];
    let foregroundSum = 0;
    let backgroundSum = 0;
    while (head < tail) {
      const i = queue[head++];
      pixels.push(i);
      foregroundSum += toForeground[i];
      backgroundSum += toBackground[i];
      const x = i % width;
      const add = index => {
        if (index < 0 || index >= total || visited[index] || alpha[index] >= holeLevel) return;
        visited[index] = 1;
        queue[tail++] = index;
      };
      if (x > 0) add(i - 1);
      if (x < width - 1) add(i + 1);
      if (i >= width) add(i - width);
      if (i < total - width) add(i + width);
    }
    if (pixels.length > total * maxShare) continue;
    const meanForeground = foregroundSum / pixels.length;
    const meanBackground = backgroundSum / pixels.length;
    // Keep a genuine gap transparent; only close holes that look like the subject.
    if (meanBackground < 62 && meanBackground * 1.15 < meanForeground) continue;
    for (const i of pixels) out[i] = Math.max(out[i], 248);
    filled += pixels.length;
  }

  return { alpha: out, filled };
}

export function removeTinyForegroundIslands(alpha, width, height, options = {}) {
  const total = width * height;
  const visited = new Uint8Array(total);
  const out = new Uint8Array(alpha);
  const queue = new Int32Array(total);
  const components = [];
  const level = options.level ?? 48;

  for (let start = 0; start < total; start++) {
    if (visited[start] || alpha[start] < level) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const pixels = [];
    let minX = width, maxX = 0, minY = height, maxY = 0;
    while (head < tail) {
      const i = queue[head++];
      pixels.push(i);
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const add = index => {
        if (index < 0 || index >= total || visited[index] || alpha[index] < level) return;
        visited[index] = 1;
        queue[tail++] = index;
      };
      if (x > 0) add(i - 1);
      if (x < width - 1) add(i + 1);
      if (i >= width) add(i - width);
      if (i < total - width) add(i + width);
    }
    components.push({ pixels, area: pixels.length, minX, maxX, minY, maxY });
  }

  if (!components.length) return out;
  components.sort((a, b) => b.area - a.area);
  const largest = components[0].area;
  const hardTiny = Math.max(14, Math.round(total * 0.00009));
  const softTiny = Math.max(50, Math.round(total * 0.00032));
  const relative = largest * 0.008;

  for (let index = 1; index < components.length; index++) {
    const component = components[index];
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const definitelyTiny = component.area <= hardTiny;
    const smallAndCompact =
      component.area <= Math.min(softTiny, relative) &&
      boxWidth <= Math.max(16, Math.round(width * 0.045)) &&
      boxHeight <= Math.max(16, Math.round(height * 0.045));
    if (definitelyTiny || smallAndCompact) {
      for (const i of component.pixels) out[i] = 0;
    }
  }
  return out;
}

/**
 * Nudge partially transparent edge pixels toward the colour they actually match.
 * This is what removes the leftover background ring without moving the silhouette.
 */
export function colourRatioEdgeRefine(alpha, distances, width, height, options = {}) {
  const total = width * height;
  const low = options.low ?? 12;
  const high = options.high ?? 244;
  const strength = options.strength ?? 0.55;
  const confidenceScale = options.confidenceScale ?? 70;
  const { toForeground, toBackground } = distances;
  const out = new Uint8Array(alpha);

  for (let i = 0; i < total; i++) {
    const a = alpha[i];
    if (a <= low || a >= high) continue;
    const background = toBackground[i];
    const foreground = toForeground[i];
    const sum = background + foreground;
    if (!sum || background >= UNKNOWN_DISTANCE || foreground >= UNKNOWN_DISTANCE) continue;
    const target = 255 * (background / sum);
    const confidence = Math.min(1, Math.abs(foreground - background) / confidenceScale);
    const blend = strength * confidence;
    out[i] = Math.round(a * (1 - blend) + target * blend);
  }
  return out;
}

export function featherAlphaBand(alpha, width, height, options = {}) {
  const low = options.low ?? 6;
  const high = options.high ?? 250;
  const keep = options.keep ?? 0.62;
  const out = new Uint8Array(alpha);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const a = alpha[i];
      if (a <= low || a >= high) continue;
      let sum = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const row = (y + oy) * width + x;
        sum += alpha[row - 1] + alpha[row] + alpha[row + 1];
      }
      out[i] = Math.round(a * keep + (sum / 9) * (1 - keep));
    }
  }
  return out;
}

export function alphaBounds(alpha, width, height, threshold = 128) {
  let area = 0;
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] < threshold) continue;
    area++;
    const x = i % width;
    const y = (i / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    area,
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0
  };
}

/**
 * Extent of the biggest visible blob. Whole-mask bounds are easily skewed by a
 * stray fragment in a corner, which then makes removing that fragment look like
 * the subject collapsed.
 */
export function largestComponentBounds(alpha, width, height, threshold = 128) {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let best = { area: 0, width: 0, height: 0 };

  for (let start = 0; start < total; start++) {
    if (visited[start] || alpha[start] < threshold) continue;
    let head = 0;
    let tail = 0;
    visited[start] = 1;
    queue[tail++] = start;
    let area = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    while (head < tail) {
      const i = queue[head++];
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const add = index => {
        if (index < 0 || index >= total || visited[index] || alpha[index] < threshold) return;
        visited[index] = 1;
        queue[tail++] = index;
      };
      if (x > 0) add(i - 1);
      if (x < width - 1) add(i + 1);
      if (y > 0) add(i - width);
      if (y < height - 1) add(i + width);
    }
    if (area > best.area) best = { area, width: maxX - minX + 1, height: maxY - minY + 1 };
  }
  return best;
}

/**
 * A refinement stage may only be accepted when the subject keeps its extent.
 * `minArea` is deliberately loose for reclaim (removing background *should* shrink
 * the area) and tight for cosmetic stages.
 */
export function shapeSurvived(before, after, width, height, limits = {}) {
  const first = largestComponentBounds(before, width, height);
  const second = largestComponentBounds(after, width, height);
  if (!first.area) return true;
  if (!second.area) return false;
  const minArea = limits.minArea ?? 0.9;
  const minSpan = limits.minSpan ?? 0.9;
  return (
    second.area / first.area >= minArea &&
    (!first.width || second.width / first.width >= minSpan) &&
    (!first.height || second.height / first.height >= minSpan)
  );
}

const identityBreathe = () => Promise.resolve();

/**
 * Full refinement pass. `rgb` and `alpha` must both be at the working resolution.
 * Returns the refined alpha plus a report describing which stages were accepted.
 */
export async function refineForegroundAlpha({ rgb, alpha, width, height, options = {}, breathe = identityBreathe }) {
  const report = { guided: false, reclaimed: 0, evidence: 0, filled: 0, edge: false, rolledBack: false };
  const total = width * height;
  if (!total || alpha.length !== total) return { alpha: new Uint8Array(alpha), report };

  const channels = colourChannels(rgb, width, height);
  const edges = colourEdgeStrength(channels, width, height);
  await breathe();

  let current = new Uint8Array(alpha);

  const guideRadius = options.guideRadius ?? Math.max(3, Math.min(12, Math.round(Math.max(width, height) / 190)));
  const guideEps = options.guideEps ?? 2e-4;
  const normalised = new Float32Array(total);
  for (let i = 0; i < total; i++) normalised[i] = current[i] / 255;

  // The colour guide needs about a dozen float buffers. Very large working sizes,
  // or a device that refuses the allocation, fall back to the luma guide.
  let guided;
  const colourGuideBudget = options.colourGuideBudget ?? 2.2e6;
  try {
    guided = total <= colourGuideBudget
      ? guidedFilterColour(channels, normalised, width, height, guideRadius, guideEps)
      : guidedFilter(luminanceField(rgb, width, height), normalised, width, height, guideRadius, guideEps);
  } catch (error) {
    console.warn("Colour-guided mask refinement unavailable; using the luma guide", error);
    guided = guidedFilter(luminanceField(rgb, width, height), normalised, width, height, guideRadius, guideEps);
  }
  const guidedAlpha = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const value = Math.round(guided[i] * 255);
    guidedAlpha[i] = value < 6 ? 0 : value > 249 ? 255 : value;
  }
  if (shapeSurvived(current, guidedAlpha, width, height, { minArea: 0.86, minSpan: 0.9 })) {
    current = guidedAlpha;
    report.guided = true;
  }
  await breathe();

  const models = buildLocalColourModels(rgb, current, width, height, options.models);
  const distances = colourDistanceMaps(rgb, models, width, height);
  await breathe();

  const beforeReclaim = current;
  const reclaim = reclaimConnectedBackground(current, distances, edges, width, height, options.reclaim);
  report.evidence = Math.round(reclaim.evidence);
  if (
    reclaim.removed &&
    reclaim.evidence >= (options.reclaimMinEvidence ?? 22) &&
    shapeSurvived(beforeReclaim, reclaim.alpha, width, height, {
      minArea: options.reclaimMinArea ?? 0.4,
      minSpan: options.reclaimMinSpan ?? 0.8
    })
  ) {
    current = reclaim.alpha;
    report.reclaimed = reclaim.removed;
  }
  await breathe();

  const holes = fillSubjectHoles(current, distances, width, height, options.holes);
  current = holes.alpha;
  report.filled = holes.filled;

  current = removeTinyForegroundIslands(current, width, height);
  await breathe();

  const matted = colourRatioEdgeRefine(current, distances, width, height, options.edge);
  if (shapeSurvived(current, matted, width, height, { minArea: 0.9, minSpan: 0.94 })) {
    current = matted;
    report.edge = true;
  }
  current = featherAlphaBand(current, width, height, options.feather);
  await breathe();

  if (!shapeSurvived(alpha, current, width, height, {
    minArea: options.finalMinArea ?? 0.5,
    minSpan: options.finalMinSpan ?? 0.72
  })) {
    report.rolledBack = true;
    return { alpha: removeTinyForegroundIslands(alpha, width, height), report };
  }

  return { alpha: current, report };
}
