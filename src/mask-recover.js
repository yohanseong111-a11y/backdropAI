/*
 * Recover a subject the segmentation model deleted.
 *
 * RMBG is trained to find "the object", but a close-up garment on a busy carpet
 * often comes back inverted or with a bite that reaches the photo edge. The
 * previous reclaim pass treated anything touching the frame as background, so a
 * jacket that touches the crop was eaten. These helpers look at the *photo*
 * (border colour vs subject colour) instead of trusting the mask's holes.
 */

function packClusters(bins, maxClusters) {
  const ranked = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, maxClusters);
  const packed = new Float32Array(ranked.length * 3);
  ranked.forEach((entry, index) => {
    packed[index * 3] = entry.r / entry.n;
    packed[index * 3 + 1] = entry.g / entry.n;
    packed[index * 3 + 2] = entry.b / entry.n;
  });
  return packed;
}

function addSample(bins, rgb, index) {
  const o = index * 4;
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

function nearestDistance(clusters, r, g, b) {
  if (!clusters.length) return 999;
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

export function frameCoverage(alpha, width, height, threshold = 128) {
  const inset = Math.max(2, Math.round(Math.min(width, height) * 0.08));
  let border = 0;
  let borderOpaque = 0;
  let interior = 0;
  let interiorOpaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const opaque = alpha[y * width + x] >= threshold;
      const onBorder = y < inset || y >= height - inset || x < inset || x >= width - inset;
      if (onBorder) {
        border++;
        if (opaque) borderOpaque++;
      } else {
        interior++;
        if (opaque) interiorOpaque++;
      }
    }
  }
  return {
    borderOpaque: border ? borderOpaque / border : 0,
    interiorOpaque: interior ? interiorOpaque / interior : 0
  };
}

export function invertAlpha(alpha) {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = 255 - alpha[i];
  return out;
}

/**
 * The model deleted the product: the frame still looks "kept" (carpet) while the
 * middle of the photo is empty (the jacket).
 */
export function maskLooksInverted(alpha, width, height) {
  const { borderOpaque, interiorOpaque } = frameCoverage(alpha, width, height);
  return borderOpaque > 0.38 && interiorOpaque < borderOpaque - 0.16 && interiorOpaque < 0.55;
}

function borderClusters(rgb, width, height, maxClusters = 4) {
  const bins = new Map();
  const step = Math.max(1, Math.round(Math.max(width, height) / 280));
  for (let x = 0; x < width; x += step) {
    addSample(bins, rgb, x);
    addSample(bins, rgb, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y += step) {
    addSample(bins, rgb, y * width);
    addSample(bins, rgb, y * width + width - 1);
  }
  return packClusters(bins, maxClusters);
}

function opaqueClusters(rgb, alpha, width, height, level, maxClusters = 5) {
  const bins = new Map();
  const step = Math.max(1, Math.round(Math.max(width, height) / 360));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x;
      if (alpha[i] >= level) addSample(bins, rgb, i);
    }
  }
  return packClusters(bins, maxClusters);
}

function clustersSeparated(foreground, background, minDistance = 28) {
  if (!foreground.length || !background.length) return false;
  let best = Infinity;
  for (let f = 0; f < foreground.length; f += 3) {
    const distance = nearestDistance(background, foreground[f], foreground[f + 1], foreground[f + 2]);
    if (distance < best) best = distance;
  }
  return best >= minDistance;
}

/**
 * Grow the kept subject into transparent pixels that still look like it — including
 * bites that touch the photo edge, which border-seeded reclaim would call background.
 */
export function restoreSubjectColouredGaps(rgb, alpha, width, height, options = {}) {
  const total = width * height;
  const subjectLevel = options.subjectLevel ?? 220;
  const emptyLevel = options.emptyLevel ?? 80;
  const maxDistance = options.maxDistance ?? 58;
  const separation = options.separation ?? 1.12;
  const foreground = opaqueClusters(rgb, alpha, width, height, subjectLevel);
  const background = borderClusters(rgb, width, height);
  const out = new Uint8Array(alpha);
  if (!foreground.length || !clustersSeparated(foreground, background, options.minSeparation ?? 26)) {
    return { alpha: out, restored: 0 };
  }

  const queue = new Int32Array(total);
  const seen = new Uint8Array(total);
  let head = 0;
  let tail = 0;
  let restored = 0;
  for (let i = 0; i < total; i++) {
    if (alpha[i] >= subjectLevel) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  if (!tail) return { alpha: out, restored: 0 };

  const consider = index => {
    if (index < 0 || index >= total || seen[index]) return;
    seen[index] = 1;
    if (alpha[index] > emptyLevel) return;
    const o = index * 4;
    const toSubject = nearestDistance(foreground, rgb[o], rgb[o + 1], rgb[o + 2]);
    const toBorder = nearestDistance(background, rgb[o], rgb[o + 1], rgb[o + 2]);
    if (toSubject > maxDistance || toSubject > toBorder * separation) return;
    out[index] = 255;
    restored++;
    queue[tail++] = index;
  };

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) consider(i - 1);
    if (x < width - 1) consider(i + 1);
    if (i >= width) consider(i - width);
    if (i < total - width) consider(i + width);
  }

  return { alpha: out, restored };
}

export function recoverDeletedSubject(rgb, alpha, width, height) {
  let current = new Uint8Array(alpha);
  let inverted = false;
  if (maskLooksInverted(current, width, height)) {
    current = invertAlpha(current);
    inverted = true;
  }
  const gaps = restoreSubjectColouredGaps(rgb, current, width, height);
  return { alpha: gaps.alpha, inverted, restored: gaps.restored };
}
