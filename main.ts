// Cryo-Toast 3000 — catalogue photo of an impossible gadget (a toaster that toasts ice cubes).
// Node 22 stdlib-only. Renders a 1024x1024 studio product shot to /output/entry.png.
// No network, no randomness (seeded LCG only), fully deterministic.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------- deterministic PRNG ----------
let seed = 123456789;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

// ---------- pixel buffer ----------
const buf = new Uint8Array(W * H * 3);
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function sstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
// alpha-composite an RGB colour over the buffer at (x,y)
function put(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  if (a > 1) a = 1;
  const i = (y * W + x) * 3;
  buf[i] = Math.round(lerp(buf[i], r, a));
  buf[i + 1] = Math.round(lerp(buf[i + 1], g, a));
  buf[i + 2] = Math.round(lerp(buf[i + 2], b, a));
}
// signed distance to an axis-aligned rounded box centred at (cx,cy) with half-size (hx,hy), radius r
function sdRoundBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number): number {
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  return (Math.hypot(dx, dy) - 1) * Math.min(rx, ry);
}
// fill a rounded rect over its bbox; colour fn gives [r,g,b,a] per pixel
function fillRoundBox(cx: number, cy: number, hx: number, hy: number, r: number,
  col: (x: number, y: number) => [number, number, number, number]): void {
  const x0 = Math.max(0, Math.floor(cx - hx - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + hx + 2));
  const y0 = Math.max(0, Math.floor(cy - hy - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + hy + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = sdRoundBox(x + 0.5, y + 0.5, cx, cy, hx, hy, r);
      const a = clamp(0.5 - d, 0, 1);
      if (a <= 0) continue;
      const c = col(x, y);
      put(x, y, c[0], c[1], c[2], c[3] * a);
    }
  }
}
function fillEllipse(cx: number, cy: number, rx: number, ry: number,
  col: (x: number, y: number) => [number, number, number, number]): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = sdEllipse(x + 0.5, y + 0.5, cx, cy, rx, ry);
      const a = clamp(0.5 - d, 0, 1);
      if (a <= 0) continue;
      const c = col(x, y);
      put(x, y, c[0], c[1], c[2], c[3] * a);
    }
  }
}
// thick line segment with round caps
function drawLine(x0: number, y0: number, x1: number, y1: number, w: number,
  r: number, g: number, b: number, a: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const pad = w / 2 + 2;
  const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + pad));
  const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + pad));
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      t = clamp(t, 0, 1);
      const cx = x0 + t * dx;
      const cy = y0 + t * dy;
      const d = Math.hypot(px - cx, py - cy) - w / 2;
      const al = clamp(0.5 - d, 0, 1) * a;
      if (al > 0) put(x, y, r, g, b, al);
    }
  }
}
// rotated rounded rect (ice cube); colour fn in local coords
function fillRotRoundBox(cx: number, cy: number, hx: number, hy: number, r: number, angDeg: number,
  col: (lx: number, ly: number) => [number, number, number, number]): void {
  const ang = (angDeg * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const ex = Math.abs(cos) * hx + Math.abs(sin) * hy + 3;
  const ey = Math.abs(sin) * hx + Math.abs(cos) * hy + 3;
  const x0 = Math.max(0, Math.floor(cx - ex));
  const x1 = Math.min(W - 1, Math.ceil(cx + ex));
  const y0 = Math.max(0, Math.floor(cy - ey));
  const y1 = Math.min(H - 1, Math.ceil(cy + ey));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      const d = sdRoundBox(lx, ly, 0, 0, hx, hy, r);
      const a = clamp(0.5 - d, 0, 1);
      if (a <= 0) continue;
      const c = col(lx, ly);
      put(x, y, c[0], c[1], c[2], c[3] * a);
    }
  }
}

// ---------- shadow layer (blurred) ----------
const shadow = new Float32Array(W * H);
function shadowEllipse(cx: number, cy: number, rx: number, ry: number, a: number): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const q = dx * dx + dy * dy;
      if (q < 1) shadow[y * W + x] = Math.max(shadow[y * W + x], a * (1 - q));
    }
  }
}
function boxBlur(src: Float32Array, radius: number): Float32Array {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const w = radius * 2 + 1;
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[y * W + clamp(x, 0, W - 1)];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / w;
      acc += src[y * W + clamp(x + radius + 1, 0, W - 1)] - src[y * W + clamp(x - radius, 0, W - 1)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[clamp(y, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / w;
      acc += tmp[clamp(y + radius + 1, 0, H - 1) * W + x] - tmp[clamp(y - radius, 0, H - 1) * W + x];
    }
  }
  return out;
}

// ---------- 5x7 bitmap font (only glyphs we need) ----------
const FONT: Record<string, string[]> = {
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
};
function drawText(text: string, x: number, y: number, s: number,
  r: number, g: number, b: number, a: number): void {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) { cx += 6 * s; continue; }
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") {
          for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
              put(cx + col * s + dx, y + row * s + dy, r, g, b, a);
            }
          }
        }
      }
    }
    cx += 6 * s;
  }
}
function textWidth(text: string, s: number): number {
  return text.length * 6 * s - s;
}

// ---------- scene ----------
function render(): void {
  // 1. Studio seamless background: warm light grey gradient + soft vignette.
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const br = lerp(244, 216, t);
    const bg = lerp(242, 210, t);
    const bb = lerp(238, 206, t);
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W / 2);
      const dy = (y - H / 2) / (H / 2);
      const vig = 1 - 0.07 * (dx * dx + dy * dy) * 0.5;
      const i = (y * W + x) * 3;
      buf[i] = Math.round(br * vig);
      buf[i + 1] = Math.round(bg * vig);
      buf[i + 2] = Math.round(bb * vig);
    }
  }
  // 2. Floor: very subtle darker band low down + faint reflection sheen.
  for (let y = 700; y < H; y++) {
    const t = (y - 700) / (H - 700);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const f = 0.05 * t;
      buf[i] = Math.round(buf[i] * (1 - f));
      buf[i + 1] = Math.round(buf[i + 1] * (1 - f));
      buf[i + 2] = Math.round(buf[i + 2] * (1 - f));
    }
  }

  // 3. Soft contact shadows (blurred layer, composited dark).
  shadowEllipse(470, 712, 265, 30, 0.42);
  shadowEllipse(800, 786, 135, 18, 0.34);
  const blurred = boxBlur(boxBlur(shadow, 10), 10);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = blurred[y * W + x];
      if (a > 0.003) put(x, y, 52, 50, 48, Math.min(a, 0.5));
    }
  }

  // 4. Plate (the ONE accessory): small white ceramic plate, lower right.
  fillEllipse(800, 758, 122, 40, () => [252, 251, 248, 1]);
  fillEllipse(800, 754, 112, 34, () => [238, 237, 233, 1]);
  fillEllipse(800, 752, 96, 28, () => [250, 249, 246, 1]);

  // 5. Toaster body: brushed chrome, 3/4 front view.
  fillRoundBox(470, 540, 220, 160, 44, (x, y) => {
    const tx = (x - 250) / 440; // 0 left .. 1 right
    let r = lerp(lerp(242, 198, tx), 158, tx * tx * 0.6);
    let g = lerp(lerp(244, 200, tx), 162, tx * tx * 0.6);
    let b = lerp(lerp(246, 204, tx), 168, tx * tx * 0.6);
    const ty = (y - 380) / 320; // 0 top .. 1 bottom
    const shade = 1 - 0.22 * ty;
    r *= shade; g *= shade; b *= shade;
    // diagonal specular band from the key light (top-left)
    const d = (x - 300) - (y - 380) * 0.55;
    const band = Math.exp(-((d / 95) * (d / 95))) * 42;
    // fine brushed horizontal lines
    const brush = Math.sin(y * 1.7) * 2.5 + (rnd() - 0.5) * 0;
    return [clamp(r + band + brush, 0, 255), clamp(g + band + brush, 0, 255), clamp(b + band + brush, 0, 255), 1];
  });
  // black plinth at the base
  fillRoundBox(470, 688, 205, 20, 10, () => [38, 39, 42, 1]);
  // top face: darker steel slab with the two slots
  fillRoundBox(470, 372, 200, 26, 14, (x, y) => {
    const tx = (x - 270) / 400;
    const v = lerp(118, 82, tx);
    return [v, v + 3, v + 6, 1];
  });
  // slots (dark interiors)
  fillRoundBox(360, 370, 62, 11, 8, () => [16, 18, 21, 1]);
  fillRoundBox(530, 370, 62, 11, 8, () => [16, 18, 21, 1]);

  // 6. Frost: thin icy speckle along the top edge near the slots.
  for (let i = 0; i < 520; i++) {
    const x = 275 + rnd() * 390;
    const y = 348 + rnd() * 26;
    const a = 0.25 + rnd() * 0.45;
    put(Math.floor(x), Math.floor(y), 226, 240, 248, a);
    if (rnd() > 0.6) put(Math.floor(x) + 1, Math.floor(y), 226, 240, 248, a * 0.7);
  }

  // 7. Cold vapour wisps curling out of the slots (behind the cubes).
  const wisps: Array<[number, number, number]> = [
    [345, 350, -1], [375, 352, 1], [520, 350, 1], [548, 352, -1],
  ];
  for (const [wx, wy, dir] of wisps) {
    for (let s = 0; s < 26; s++) {
      const t = s / 25;
      const x = wx + dir * Math.sin(t * 3.4) * 26 * t + dir * t * 18;
      const y = wy - t * 165;
      const rad = 13 + t * 22;
      const al = 0.10 * (1 - t * 0.55);
      fillEllipse(x, y, rad, rad * 0.62, () => [232, 244, 252, al]);
    }
  }

  // 8. Ice cubes popping out of the slots (the joke).
  const cubeCol = (lx: number, ly: number): [number, number, number, number] => {
    const t = clamp((ly + 55) / 110, 0, 1); // top lighter
    let r = lerp(235, 178, t);
    let g = lerp(246, 214, t);
    let b = lerp(252, 238, t);
    // diagonal highlight streak
    const d = lx - ly * 0.7;
    const hi = Math.exp(-((d / 26) * (d / 26))) * 26;
    return [clamp(r + hi, 0, 255), clamp(g + hi, 0, 255), clamp(b + hi, 0, 255), 0.96];
  };
  fillRotRoundBox(358, 252, 56, 56, 16, -18, cubeCol);
  fillRotRoundBox(532, 296, 50, 50, 14, 13, cubeCol);
  // cube edge strokes (thin darker blue outline, drawn as rotated frame lines)
  const strokeCube = (cx: number, cy: number, h: number, ang: number): void => {
    const a = (ang * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const corners: Array<[number, number]> = [[-h, -h], [h, -h], [h, h], [-h, h]];
    const pts = corners.map(([lx, ly]) => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos] as [number, number]);
    for (let k = 0; k < 4; k++) {
      const p = pts[k];
      const q = pts[(k + 1) % 4];
      drawLine(p[0], p[1], q[0], q[1], 3, 140, 180, 205, 0.55);
    }
  };
  strokeCube(358, 252, 56, -18);
  strokeCube(532, 296, 50, 13);

  // 9. Lever (right side, pressed down) + dial + LED.
  fillRoundBox(700, 500, 12, 62, 8, () => [44, 46, 49, 1]);
  fillRoundBox(700, 556, 20, 14, 7, () => [26, 27, 30, 1]); // knob, pressed low
  // dial with snowflake glyph
  fillEllipse(470, 566, 47, 47, () => [228, 231, 233, 1]);
  fillEllipse(470, 566, 47, 47, (x, y) => {
    const d = Math.hypot(x - 470, y - 566);
    return [228, 231, 233, d > 43 ? 0 : 0];
  });
  drawLine(470, 566, 470, 534, 3, 90, 120, 140, 0.9);
  drawLine(470, 566, 470, 598, 3, 90, 120, 140, 0.9);
  drawLine(470, 566, 442, 550, 3, 90, 120, 140, 0.9);
  drawLine(470, 566, 498, 582, 3, 90, 120, 140, 0.9);
  drawLine(470, 566, 498, 550, 3, 90, 120, 140, 0.9);
  drawLine(470, 566, 442, 582, 3, 90, 120, 140, 0.9);
  // ring around dial
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    put(Math.round(470 + Math.cos(a) * 46), Math.round(566 + Math.sin(a) * 46), 120, 124, 128, 0.8);
  }
  // blue LED, lit
  fillEllipse(618, 516, 16, 16, () => [90, 170, 255, 0.28]);
  fillEllipse(618, 516, 8, 8, () => [120, 200, 255, 1]);
  fillEllipse(618, 516, 4, 4, () => [220, 240, 255, 1]);

  // 10. Brand text on the body (product text only).
  const brand = "CRYO-TOAST";
  const bs = 3;
  drawText(brand, 470 - Math.floor(textWidth(brand, bs) / 2), 622, bs, 58, 61, 64, 0.92);
  const model = "3000";
  const ms = 2;
  drawText(model, 470 - Math.floor(textWidth(model, ms) / 2), 652, ms, 96, 100, 104, 0.9);

  // 11. The one accessory, completed: a single ice cube on the plate.
  fillRotRoundBox(800, 706, 34, 34, 10, 9, cubeCol);
  strokeCube(800, 706, 34, 9);
  // tiny cube shadow on the plate
  fillEllipse(802, 736, 34, 8, () => [120, 124, 128, 0.25]);
}

// ---------- PNG encoder ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter none
    raw.set(buf.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function main(): void {
  render();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const png = encodePNG();
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
}

main();
