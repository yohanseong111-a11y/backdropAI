/*
 * Synthetic stand-in for the hard case reported from phone photos: a light denim
 * subject on textured grey concrete, with a narrow gap between two legs.
 *
 * `coarseAlpha` imitates what a small inference square produces — the gap between
 * the legs is filled in, the silhouette is dilated into a halo of original
 * background, and a stray fragment of background is left behind.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCENE = {
  width: 160,
  height: 220,
  torso: { x0: 44, x1: 116, y0: 26, y1: 108 },
  leftLeg: { x0: 48, x1: 74, y0: 108, y1: 196 },
  rightLeg: { x0: 86, x1: 112, y0: 108, y1: 196 },
  gap: { x0: 74, x1: 86, y0: 108, y1: 196 },
  fragment: { x0: 16, x1: 26, y0: 24, y1: 34 },
  halo: 5
};

const inside = (box, x, y) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;

export function isSubject(x, y) {
  return inside(SCENE.torso, x, y) || inside(SCENE.leftLeg, x, y) || inside(SCENE.rightLeg, x, y);
}

export function buildScene() {
  const { width, height } = SCENE;
  const total = width * height;
  const rgb = new Uint8ClampedArray(total * 4);
  const truth = new Uint8Array(total);
  const random = mulberry32(20260821);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      if (isSubject(x, y)) {
        truth[i] = 1;
        // Light denim. Almost isoluminant with the concrete, so a luma-only
        // guide cannot see this boundary at all.
        const shade = random() * 14 - 7;
        rgb[o] = 112 + shade;
        rgb[o + 1] = 150 + shade;
        rgb[o + 2] = 201 + shade;
      } else {
        const grain = random() * 16 - 8;
        rgb[o] = 149 + grain;
        rgb[o + 1] = 147 + grain;
        rgb[o + 2] = 144 + grain;
      }
      rgb[o + 3] = 255;
    }
  }
  return { rgb, truth, width, height };
}

export function buildCoarseAlpha() {
  const { width, height, halo } = SCENE;
  const alpha = new Uint8Array(width * height);
  const blob = { x0: SCENE.leftLeg.x0, x1: SCENE.rightLeg.x1, y0: SCENE.leftLeg.y0, y1: SCENE.leftLeg.y1 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // The legs merge into one block: the gap between them is lost.
      const solid = inside(SCENE.torso, x, y) || inside(blob, x, y);
      if (solid) {
        alpha[y * width + x] = 255;
        continue;
      }
      // Dilate the silhouette so background survives all around the subject.
      let near = false;
      for (let oy = -halo; oy <= halo && !near; oy++) {
        for (let ox = -halo; ox <= halo; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (inside(SCENE.torso, nx, ny) || inside(blob, nx, ny)) { near = true; break; }
        }
      }
      if (near) alpha[y * width + x] = 255;
      if (inside(SCENE.fragment, x, y)) alpha[y * width + x] = 255;
    }
  }
  return alpha;
}

export function regionStats(alpha, width, box, threshold = 128) {
  let opaque = 0;
  let count = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      count++;
      if (alpha[y * width + x] >= threshold) opaque++;
    }
  }
  return { count, opaque, share: count ? opaque / count : 0 };
}

export function subjectRetention(alpha, truth, threshold = 128) {
  let kept = 0;
  let total = 0;
  for (let i = 0; i < truth.length; i++) {
    if (!truth[i]) continue;
    total++;
    if (alpha[i] >= threshold) kept++;
  }
  return total ? kept / total : 0;
}

export function backgroundLeftover(alpha, truth, threshold = 128) {
  let leftover = 0;
  let total = 0;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i]) continue;
    total++;
    if (alpha[i] >= threshold) leftover++;
  }
  return total ? leftover / total : 0;
}
