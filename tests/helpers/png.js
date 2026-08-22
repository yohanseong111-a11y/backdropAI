/*
 * Minimal 8-bit RGB/RGBA PNG reader for fixture photos. No dependencies.
 */
import {readFile} from "node:fs/promises";
import {inflateSync} from "node:zlib";

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function recon(filter, row, prev, bpp) {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? out[i - bpp] : 0;
    const up = prev[i];
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (filter === 1) pred = left;
    else if (filter === 2) pred = up;
    else if (filter === 3) pred = (left + up) >> 1;
    else if (filter === 4) pred = paeth(left, up, upLeft);
    out[i] = (row[i] + pred) & 255;
  }
  return out;
}

export function decodePng(buffer) {
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50) throw new Error("not a png");
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const chunk = buffer.subarray(start, start + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      depth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported png ${depth}/${colorType}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rgb = new Uint8ClampedArray(width * height * 4);
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = recon(filter, raw.subarray(src, src + stride), prev, bpp);
    src += stride;
    prev = row;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = x * bpp;
      rgb[i] = row[o];
      rgb[i + 1] = row[o + 1];
      rgb[i + 2] = row[o + 2];
      rgb[i + 3] = bpp === 4 ? row[o + 3] : 255;
    }
  }
  return {width, height, rgb};
}

export async function readPng(path) {
  return decodePng(await readFile(path));
}
