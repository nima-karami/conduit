/**
 * Minimal PNG reader for Chromium screenshots (8-bit, non-interlaced, RGB or RGBA).
 *
 * Why it exists: a DOM surface cannot be rasterised from inside the page, so anything that has
 * to be asserted on REAL composited pixels — a translucent row wash over a translucent surface,
 * say — has to go out through `page.screenshot` and come back decoded. Canvas surfaces
 * (the overview ruler, the minimap) do not need this: `getImageData` reads those in-page.
 */

import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  let colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, data: out };
}

export function pxAt(img, x, y) {
  const i = y * img.w * img.ch + x * img.ch;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

export const hex = (rgb) => `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/** Two hex colours agree to within `tol` on every channel — the tolerance a compositor's own
 *  rounding needs, and small enough that a second surface layered in would still fail. */
export function channelsWithin(a, b, tol) {
  const ch = (s) => [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [ch(a), ch(b)];
  return x.every((v, i) => Math.abs(v - y[i]) <= tol);
}
