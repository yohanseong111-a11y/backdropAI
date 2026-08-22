/*
 * Recover a subject the segmentation model deleted.
 *
 * Close-up garments often touch the photo edge. Using the frame RGB as
 * "background" then refuses to restore jacket-coloured holes, because the
 * crop itself is jacket. These helpers learn background from colours that are
 * *not* the kept subject, and from agreeing corners (carpet in the corners,
 * product in the middle).
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

function colourDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function meanPatch(rgb, x0, y0, size, width, height) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < Math.min(height, y0 + size); y++) {
    for (let x = x0; x < Math.min(width, x0 + size); x++) {
      const o = (y * width + x) * 4;
      r += rgb[o];
      g += rgb[o + 1];
      b += rgb[o + 2];
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
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

export function maskLooksInverted(alpha, width, height) {
  const { borderOpaque, interiorOpaque } = frameCoverage(alpha, width, height);
  return borderOpaque > 0.38 && interiorOpaque < borderOpaque - 0.16 && interiorOpaque < 0.55;
}

function opaqueClusters(rgb, alpha, width, height, level, maxClusters = 5, skipColour = null, skipDistance = 36) {
  const bins = new Map();
  const step = Math.max(1, Math.round(Math.max(width, height) / 360));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x;
      if (alpha[i] < level) continue;
      const o = i * 4;
      if (skipColour && colourDistance([rgb[o], rgb[o + 1], rgb[o + 2]], skipColour) < skipDistance) continue;
      addSample(bins, rgb, i);
    }
  }
  return packClusters(bins, maxClusters);
}

function distinctBackgroundClusters(rgb, alpha, width, height, foreground, emptyLevel, minDistance) {
  const bins = new Map();
  const step = Math.max(1, Math.round(Math.max(width, height) / 320));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x;
      if (alpha[i] > emptyLevel) continue;
      const o = i * 4;
      if (nearestDistance(foreground, rgb[o], rgb[o + 1], rgb[o + 2]) < minDistance) continue;
      addSample(bins, rgb, i);
    }
  }
  return packClusters(bins, 4);
}

/**
 * When two or more corners share a colour that is different from the centre,
 * that colour is the backdrop (carpet in the corners, product in the middle).
 */
export function cornerBackgroundSeed(rgb, width, height) {
  const patch = Math.max(6, Math.round(Math.min(width, height) * 0.06));
  const corners = [
    meanPatch(rgb, 0, 0, patch, width, height),
    meanPatch(rgb, width - patch, 0, patch, width, height),
    meanPatch(rgb, 0, height - patch, patch, width, height),
    meanPatch(rgb, width - patch, height - patch, patch, width, height)
  ];
  const center = meanPatch(
    rgb,
    Math.round(width * 0.35),
    Math.round(height * 0.35),
    Math.round(Math.min(width, height) * 0.3),
    width,
    height
  );

  let best = null;
  let bestScore = 0;
  for (let i = 0; i < 4; i++) {
    let count = 0;
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < 4; j++) {
      if (colourDistance(corners[i], corners[j]) > 28) continue;
      count++;
      r += corners[j][0];
      g += corners[j][1];
      b += corners[j][2];
    }
    if (count < 2) continue;
    const mean = [r / count, g / count, b / count];
    const score = colourDistance(mean, center);
    if (score > bestScore) {
      bestScore = score;
      best = mean;
    }
  }
  if (!best || bestScore < 30) return null;
  return { colour: best, separation: bestScore };
}

export function cornerBackgroundFlood(rgb, width, height, options = {}) {
  const seed = cornerBackgroundSeed(rgb, width, height);
  if (!seed) return { subject: null, confident: false };
  const total = width * height;
  const tolerance = options.tolerance ?? Math.max(42, seed.separation * 0.55);
  const background = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const consider = index => {
    if (index < 0 || index >= total || background[index]) return;
    const o = index * 4;
    if (colourDistance([rgb[o], rgb[o + 1], rgb[o + 2]], seed.colour) > tolerance) return;
    background[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) {
    consider(x);
    consider((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    consider(y * width);
    consider(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) consider(i - 1);
    if (x < width - 1) consider(i + 1);
    if (i >= width) consider(i - width);
    if (i < total - width) consider(i + width);
  }
  let bgCount = 0;
  for (let i = 0; i < total; i++) bgCount += background[i];
  const ratio = bgCount / total;
  if (ratio < 0.04 || ratio > 0.72) return { subject: null, confident: false };
  const subject = new Uint8Array(total);
  for (let i = 0; i < total; i++) subject[i] = background[i] ? 0 : 255;
  return { subject, confident: true, ratio };
}

/**
 * Grow the kept subject into transparent pixels that still look like it.
 * Works even when the jacket touches the crop, because background is learned
 * from non-subject colours, not from the photo border.
 */
export function restoreSubjectColouredGaps(rgb, alpha, width, height, options = {}) {
  const total = width * height;
  const subjectLevel = options.subjectLevel ?? 220;
  const emptyLevel = options.emptyLevel ?? 80;
  const maxDistance = options.maxDistance ?? 62;
  const neighborDistance = options.neighborDistance ?? 30;
  const minSeparation = options.minSeparation ?? 26;
  const seed = cornerBackgroundSeed(rgb, width, height);
  const foreground = opaqueClusters(
    rgb,
    alpha,
    width,
    height,
    subjectLevel,
    5,
    seed?.colour,
    36
  );
  const out = new Uint8Array(alpha);
  if (!foreground.length) return { alpha: out, restored: 0 };

  const background = distinctBackgroundClusters(
    rgb,
    alpha,
    width,
    height,
    foreground,
    emptyLevel,
    minSeparation
  );
  const hasBackground = background.length > 0;

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

  const consider = (index, from) => {
    if (index < 0 || index >= total || seen[index]) return;
    seen[index] = 1;
    if (alpha[index] > emptyLevel) return;
    const o = index * 4;
    const pixel = [rgb[o], rgb[o + 1], rgb[o + 2]];
    const toSubject = nearestDistance(foreground, pixel[0], pixel[1], pixel[2]);
    const fo = from * 4;
    const fromPixel = [rgb[fo], rgb[fo + 1], rgb[fo + 2]];
    const toNeighbor = colourDistance(pixel, fromPixel);
    // A shadowed sleeve can be farther than `maxDistance` from the highlight
    // the model kept. Walk through those shades via the neighbour we grew from,
    // otherwise the dark half of a jacket stays a hole.
    if (toSubject > maxDistance) {
      if (toNeighbor > neighborDistance) return;
      const parentRestored = alpha[from] <= emptyLevel && out[from] >= 220;
      const parentSubject = nearestDistance(foreground, fromPixel[0], fromPixel[1], fromPixel[2]) <= maxDistance;
      if (!parentRestored && !parentSubject) return;
    }
    if (seed && colourDistance(pixel, seed.colour) < 36) return;
    // A deleted shadow is transparent, so it used to be learned as "background"
    // and then this walk refused to enter it. When the step is a local shade
    // change, trust the neighbour and only reject the known backdrop colour.
    if (hasBackground && toNeighbor > neighborDistance) {
      const toBackground = nearestDistance(background, pixel[0], pixel[1], pixel[2]);
      if (toSubject > toBackground * (options.separation ?? 1.05)) return;
    }
    out[index] = 255;
    restored++;
    queue[tail++] = index;
  };

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) consider(i - 1, i);
    if (x < width - 1) consider(i + 1, i);
    if (i >= width) consider(i - width, i);
    if (i < total - width) consider(i + width, i);
  }

  return { alpha: out, restored };
}

function unionSubject(alpha, extra) {
  if (!extra) return { alpha, added: 0 };
  const out = new Uint8Array(alpha);
  let added = 0;
  for (let i = 0; i < out.length; i++) {
    if (extra[i] >= 220 && out[i] < 128) {
      out[i] = 255;
      added++;
    }
  }
  return { alpha: out, added };
}

export function recoverDeletedSubject(rgb, alpha, width, height) {
  let current = new Uint8Array(alpha);
  let inverted = false;
  if (maskLooksInverted(current, width, height)) {
    current = invertAlpha(current);
    inverted = true;
  }
  const { interiorOpaque } = frameCoverage(current, width, height);
  const flood = cornerBackgroundFlood(rgb, width, height);
  let added = 0;
  // Only adopt the colour prior when the model deleted the product. Using it on
  // a normal over-covered mask would paint the backdrop back in and then
  // reclaim would have no transparent seed left.
  if (flood.confident && (inverted || interiorOpaque < 0.45)) {
    const merged = unionSubject(current, flood.subject);
    current = merged.alpha;
    added = merged.added;
  }
  const gaps = restoreSubjectColouredGaps(rgb, current, width, height);
  return {
    alpha: gaps.alpha,
    inverted,
    restored: gaps.restored + added,
    cornerFlood: flood.confident && (inverted || interiorOpaque < 0.45)
  };
}
