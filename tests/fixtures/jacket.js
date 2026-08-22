/*
 * Close-up cyan jacket on green shag carpet — the failure from the live photos.
 *
 * RMBG often nicks zipper hardware and specular shine, leaving interior holes.
 * Those holes used to be treated as proven background, so reclaim ate rectangular
 * chunks of the garment while the carpet around it survived.
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

export const JACKET = {
  width: 160,
  height: 200,
  body: { x0: 30, x1: 130, y0: 24, y1: 186 },
  holeA: { x0: 46, x1: 72, y0: 48, y1: 78 },
  holeB: { x0: 90, x1: 100, y0: 68, y1: 78 },
  halo: 4
};

const inside = (box, x, y) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;

export function isJacket(x, y) {
  return inside(JACKET.body, x, y);
}

export function buildJacketScene() {
  const { width, height } = JACKET;
  const total = width * height;
  const rgb = new Uint8ClampedArray(total * 4);
  const truth = new Uint8Array(total);
  const random = mulberry32(20260822);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      if (isJacket(x, y)) {
        truth[i] = 1;
        const shade = random() * 18 - 9;
        rgb[o] = 8 + shade * 0.2;
        rgb[o + 1] = 168 + shade;
        rgb[o + 2] = 228 + shade;
      } else {
        const pile = random() * 22 - 11;
        rgb[o] = 36 + pile;
        rgb[o + 1] = 112 + pile;
        rgb[o + 2] = 42 + pile * 0.6;
      }
      rgb[o + 3] = 255;
    }
  }
  return { rgb, truth, width, height };
}

export function buildJacketCoarseAlpha() {
  const { width, height, halo } = JACKET;
  const alpha = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isJacket(x, y)) {
        alpha[y * width + x] = 255;
        continue;
      }
      let near = false;
      for (let oy = -halo; oy <= halo && !near; oy++) {
        for (let ox = -halo; ox <= halo; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (isJacket(nx, ny)) { near = true; break; }
        }
      }
      if (near) alpha[y * width + x] = 255;
    }
  }

  // Model-style interior wounds: a large rectangular bite and a zipper nick.
  for (let y = JACKET.holeA.y0; y < JACKET.holeA.y1; y++) {
    for (let x = JACKET.holeA.x0; x < JACKET.holeA.x1; x++) alpha[y * width + x] = 0;
  }
  for (let y = JACKET.holeB.y0; y < JACKET.holeB.y1; y++) {
    for (let x = JACKET.holeB.x0; x < JACKET.holeB.x1; x++) alpha[y * width + x] = 0;
  }
  return alpha;
}
