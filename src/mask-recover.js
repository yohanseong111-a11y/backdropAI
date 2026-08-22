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

/**
 * Green shag / grass / moss: G clearly leads. Navy, charcoal and cyan do not.
 * Used so a mixed corner (carpet + navy yoke) cannot mark the jacket as floor.
 */
export function isGreenDominant(r, g, b, options = {}) {
  const lead = options.lead ?? 10;
  const minG = options.minG ?? 40;
  return g >= minG && g > r + lead && g > b + Math.max(6, lead - 2);
}

export function seedLooksGreen(seed) {
  if (!seed?.colour) return false;
  return isGreenDominant(seed.colour[0], seed.colour[1], seed.colour[2], { lead: 8, minG: 36 });
}

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * White / cream fleece and letter rugs. The last navy restore treated every
 * non-green pixel as jacket, so this pile got painted back around the sleeves.
 */
export function looksLikeBrightNeutral(r, g, b) {
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return luma(r, g, b) >= 168 && sat < 58;
}

/**
 * Navy / charcoal garment the model often deletes next to cyan. Not green
 * pile, not a white rug, not grey dirt.
 */
export function looksLikeSecondaryGarment(r, g, b) {
  if (isGreenDominant(r, g, b, { lead: 12, minG: 36 })) return false;
  if (looksLikeBrightNeutral(r, g, b)) return false;
  const y = luma(r, g, b);
  if (y < 48) return true;
  return y <= 145 && b >= r + 4;
}

/**
 * True backdrop pixels for the jacket-on-carpet photos. Euclidean distance to
 * a corner seed is not enough: on a full-bleed close-up the seed is often a
 * blend of green pile and navy fabric, so navy sits ~30–40 from that mean.
 */
export function looksLikeBackdropColour(r, g, b, seed, bgLimit = 42) {
  if (looksLikeBrightNeutral(r, g, b)) return true;
  const greenLead = g - Math.max(r, b);
  if (seedLooksGreen(seed)) {
    const dist = colourDistance([r, g, b], seed.colour);
    return (dist < bgLimit && greenLead > 8 && g >= 36) || (greenLead > 16 && g >= 50);
  }
  if (seed?.colour) return colourDistance([r, g, b], seed.colour) < bgLimit;
  return isGreenDominant(r, g, b, { lead: 16, minG: 50 });
}

function meanGreenDominantCorners(rgb, width, height, patch) {
  const boxes = [
    [0, 0],
    [width - patch, 0],
    [0, height - patch],
    [width - patch, height - patch]
  ];
  let r = 0, g = 0, b = 0, n = 0, corners = 0;
  for (const [x0, y0] of boxes) {
    let cr = 0, cg = 0, cb = 0, cn = 0;
    for (let y = y0; y < Math.min(height, y0 + patch); y++) {
      for (let x = x0; x < Math.min(width, x0 + patch); x++) {
        const o = (y * width + x) * 4;
        if (!isGreenDominant(rgb[o], rgb[o + 1], rgb[o + 2])) continue;
        cr += rgb[o];
        cg += rgb[o + 1];
        cb += rgb[o + 2];
        cn++;
      }
    }
    if (cn < patch * patch * 0.12) continue;
    r += cr;
    g += cg;
    b += cb;
    n += cn;
    corners++;
  }
  if (!n || corners < 2) return null;
  return { colour: [r / n, g / n, b / n], corners };
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
  const center = meanPatch(
    rgb,
    Math.round(width * 0.35),
    Math.round(height * 0.35),
    Math.round(Math.min(width, height) * 0.3),
    width,
    height
  );
  // Full-bleed jackets put navy in the same corner patch as carpet. Prefer the
  // green pile those corners still contain, not the muddy navy+green mean.
  const green = meanGreenDominantCorners(rgb, width, height, patch);
  if (green && colourDistance(green.colour, center) >= 30) {
    return { colour: green.colour, separation: colourDistance(green.colour, center) };
  }
  const corners = [
    meanPatch(rgb, 0, 0, patch, width, height),
    meanPatch(rgb, width - patch, 0, patch, width, height),
    meanPatch(rgb, 0, height - patch, patch, width, height),
    meanPatch(rgb, width - patch, height - patch, patch, width, height)
  ];

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
    const pixel = [rgb[o], rgb[o + 1], rgb[o + 2]];
    if (looksLikeBrightNeutral(pixel[0], pixel[1], pixel[2])) {
      background[index] = 1;
      queue[tail++] = index;
      return;
    }
    if (colourDistance(pixel, seed.colour) > tolerance) return;
    if (!looksLikeBackdropColour(pixel[0], pixel[1], pixel[2], seed, Math.min(tolerance, 56))) return;
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
  for (let i = 0; i < total; i++) {
    if (background[i]) {
      subject[i] = 0;
      continue;
    }
    const o = i * 4;
    // A letter rug is not green, so the old flood called it "subject" and
    // unioned it back whenever the model had deleted the navy yoke.
    subject[i] = looksLikeBrightNeutral(rgb[o], rgb[o + 1], rgb[o + 2]) ? 0 : 255;
  }
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
    if (looksLikeBackdropColour(pixel[0], pixel[1], pixel[2], seed, 36)) return;
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

/**
 * Restore neighbouring garment panels the model deleted because they are a
 * different colour from the kept fabric (cyan body, navy collar).
 *
 * When the backdrop colour is known, grow from the kept subject into
 * neighbouring navy / charcoal. Cyan→navy is a huge colour jump, so a
 * same-shade walk never enters the yoke. Growing into *every* non-green
 * pixel also painted white rugs and leftover ground back onto the cutout.
 *
 * Without a seed, keep the conservative colour-blob path so a jeans-on-
 * concrete gap is not painted back in.
 */
export function restoreNonBackgroundPanels(rgb, alpha, width, height, options = {}) {
  const total = width * height;
  const subjectLevel = options.subjectLevel ?? 220;
  const emptyLevel = options.emptyLevel ?? 200;
  const bgLimit = options.backgroundLimit ?? 42;
  const panelTolerance = options.panelTolerance ?? 38;
  const maxShare = options.maxShare ?? 0.4;
  const seed = options.seed || cornerBackgroundSeed(rgb, width, height);
  const out = new Uint8Array(alpha);
  const queue = new Int32Array(total);
  let restored = 0;

  const isBackdrop = (r, g, b) => looksLikeBackdropColour(r, g, b, seed, bgLimit);

  if (seed) {
    const seen = new Uint8Array(total);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < total; i++) {
      if (alpha[i] < subjectLevel) continue;
      seen[i] = 1;
      queue[tail++] = i;
    }
    const consider = index => {
      if (index < 0 || index >= total || seen[index]) return;
      seen[index] = 1;
      if (alpha[index] > emptyLevel) return;
      const o = index * 4;
      if (isBackdrop(rgb[o], rgb[o + 1], rgb[o + 2])) return;
      if (!looksLikeSecondaryGarment(rgb[o], rgb[o + 1], rgb[o + 2])) return;
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

  const visited = new Uint8Array(total);
  const touchesSubject = index => {
    const x = index % width;
    if (x > 0 && alpha[index - 1] >= subjectLevel) return true;
    if (x < width - 1 && alpha[index + 1] >= subjectLevel) return true;
    if (index >= width && alpha[index - width] >= subjectLevel) return true;
    if (index < total - width && alpha[index + width] >= subjectLevel) return true;
    return false;
  };

  for (let start = 0; start < total; start++) {
    if (visited[start] || alpha[start] > emptyLevel) continue;
    const so = start * 4;
    if (isBackdrop(rgb[so], rgb[so + 1], rgb[so + 2])) {
      visited[start] = 1;
      continue;
    }
    let head = 0;
    let tail = 0;
    visited[start] = 1;
    queue[tail++] = start;
    const pixels = [];
    let r = 0, g = 0, b = 0;
    let nextToSubject = false;
    while (head < tail) {
      const i = queue[head++];
      pixels.push(i);
      const o = i * 4;
      r += rgb[o];
      g += rgb[o + 1];
      b += rgb[o + 2];
      if (!nextToSubject && touchesSubject(i)) nextToSubject = true;
      const x = i % width;
      const add = index => {
        if (index < 0 || index >= total || visited[index] || alpha[index] > emptyLevel) return;
        const no = index * 4;
        if (isBackdrop(rgb[no], rgb[no + 1], rgb[no + 2])) {
          visited[index] = 1;
          return;
        }
        if (colourDistance([rgb[no], rgb[no + 1], rgb[no + 2]], [rgb[o], rgb[o + 1], rgb[o + 2]]) > panelTolerance) return;
        visited[index] = 1;
        queue[tail++] = index;
      };
      if (x > 0) add(i - 1);
      if (x < width - 1) add(i + 1);
      if (i >= width) add(i - width);
      if (i < total - width) add(i + width);
    }
    if (!nextToSubject) continue;
    if (pixels.length > total * maxShare) continue;
    const mean = [r / pixels.length, g / pixels.length, b / pixels.length];
    if (isBackdrop(mean[0], mean[1], mean[2])) continue;
    for (const i of pixels) {
      if (out[i] >= subjectLevel) continue;
      out[i] = 255;
      restored++;
    }
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
  current = gaps.alpha;
  added += gaps.restored;
  // A two-tone jacket (cyan body, navy collar) is two colours. The first
  // pass only grows shades of the colour the model kept. This second pass
  // grows from that fabric into neighbouring panels that are clearly not
  // the backdrop — the navy yoke the model treated as carpet.
  const panels = restoreNonBackgroundPanels(rgb, current, width, height, { flood });
  return {
    alpha: panels.alpha,
    inverted,
    restored: added + panels.restored,
    cornerFlood: flood.confident && (inverted || interiorOpaque < 0.45)
  };
}
