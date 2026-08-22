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

/**
 * The live failure: the coat is cropped by the frame, so the photo border *is*
 * jacket. A hole in the fabric must still close, and the carpet strip at the
 * top must stay gone.
 */
export function buildFullBleedJacket() {
  const width = 160;
  const height = 200;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const truth = new Uint8Array(width * height);
  const random = mulberry32(20260822);
  const carpet = 22;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      if (y < carpet) {
        const pile = random() * 22 - 11;
        rgb[o] = 36 + pile;
        rgb[o + 1] = 112 + pile;
        rgb[o + 2] = 42 + pile * 0.6;
      } else {
        truth[i] = 1;
        const shade = random() * 18 - 9;
        rgb[o] = 8 + shade * 0.2;
        rgb[o + 1] = 168 + shade;
        rgb[o + 2] = 228 + shade;
      }
      rgb[o + 3] = 255;
    }
  }
  return { rgb, truth, width, height, hole: { x0: 48, x1: 112, y0: 70, y1: 130 }, carpet };
}

/**
 * Same cyan jacket, but with a left-to-right lighting falloff. RMBG often keeps
 * the highlight and deletes the shadow, and those two shades are farther apart
 * than a single global colour threshold.
 */
export function buildLitJacketScene() {
  const width = 160;
  const height = 200;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const truth = new Uint8Array(width * height);
  const random = mulberry32(7);
  const body = { x0: 28, x1: 132, y0: 20, y1: 188 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      if (x >= body.x0 && x < body.x1 && y >= body.y0 && y < body.y1) {
        truth[i] = 1;
        const t = x / width;
        const shade = random() * 10 - 5;
        rgb[o] = Math.max(0, Math.min(255, 18 + shade + (1 - t) * 8));
        rgb[o + 1] = Math.max(0, Math.min(255, 70 + shade + (1 - t) * 140));
        rgb[o + 2] = Math.max(0, Math.min(255, 90 + shade + (1 - t) * 150));
      } else {
        const pile = random() * 18 - 9;
        rgb[o] = 36 + pile;
        rgb[o + 1] = 112 + pile;
        rgb[o + 2] = 42 + pile * 0.5;
      }
      rgb[o + 3] = 255;
    }
  }
  return { rgb, truth, width, height, body, shadow: { x0: 100, x1: body.x1, y0: body.y0, y1: body.y1 } };
}

export function buildLitJacketShadowWipe(scene) {
  const { width, height, truth, shadow } = scene;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < truth.length; i++) alpha[i] = truth[i] ? 255 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = shadow.x0; x < width; x++) alpha[y * width + x] = 0;
  }
  return alpha;
}

/**
 * The live photo: cyan body + navy collar/yoke on green carpet. RMBG keeps
 * the bright body and deletes the dark panel as if it were the backdrop.
 */
export function buildTwoToneJacket() {
  const width = 160;
  const height = 200;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const truth = new Uint8Array(width * height);
  const random = mulberry32(22);
  const body = { x0: 30, x1: 130, y0: 78, y1: 186 };
  const collar = { x0: 38, x1: 122, y0: 18, y1: 78 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const inBody = x >= body.x0 && x < body.x1 && y >= body.y0 && y < body.y1;
      const inCollar = x >= collar.x0 && x < collar.x1 && y >= collar.y0 && y < collar.y1;
      if (inBody || inCollar) {
        truth[i] = 1;
        const shade = random() * 10 - 5;
        if (inCollar) {
          rgb[o] = 18 + shade * 0.3;
          rgb[o + 1] = 22 + shade * 0.3;
          rgb[o + 2] = 48 + shade * 0.4;
        } else {
          rgb[o] = 10 + shade * 0.2;
          rgb[o + 1] = 168 + shade;
          rgb[o + 2] = 226 + shade;
        }
      } else {
        const pile = random() * 22 - 11;
        rgb[o] = 36 + pile;
        rgb[o + 1] = 112 + pile;
        rgb[o + 2] = 42 + pile * 0.6;
      }
      rgb[o + 3] = 255;
    }
  }
  return { rgb, truth, width, height, body, collar };
}

export function buildTwoToneCoarseAlpha(scene) {
  const { width, height, body, collar } = scene;
  const alpha = new Uint8Array(width * height);
  for (let y = body.y0; y < body.y1; y++) {
    for (let x = body.x0; x < body.x1; x++) alpha[y * width + x] = 255;
  }
  // Model deleted the navy collar completely.
  for (let y = collar.y0; y < collar.y1; y++) {
    for (let x = collar.x0; x < collar.x1; x++) alpha[y * width + x] = 0;
  }
  return alpha;
}

export function buildFullBleedCoarseAlpha(scene) {
  const { width, height, hole, carpet } = scene;
  const alpha = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < carpet; y++) {
    for (let x = 0; x < width; x++) alpha[y * width + x] = 0;
  }
  for (let y = hole.y0; y < hole.y1; y++) {
    for (let x = hole.x0; x < hole.x1; x++) alpha[y * width + x] = 0;
  }
  return alpha;
}
