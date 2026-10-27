// Génère icons/icon-192.png et icon-512.png (même dessin que icon.svg), sans dépendance.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };

function draw(S) {
  const px = Buffer.alloc(S * (S * 4 + 1));
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const inTri = (x, y) => { // silhouette du village
    const pts = [[96, 430], [176, 330], [216, 370], [256, 300], [296, 370], [336, 330], [416, 430]];
    if (y > 430 || y < 300) return false;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      if (x >= x1 && x <= x2) { const yy = y1 + (y2 - y1) * (x - x1) / (x2 - x1); return y >= yy; }
    }
    return false;
  };
  for (let j = 0; j < S; j++) {
    px[j * (S * 4 + 1)] = 0;
    for (let i = 0; i < S; i++) {
      let r = 0, g = 0, b = 0;
      const SS = 3; // suréchantillonnage
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (i + (sx + .5) / SS) * 512 / S, y = (j + (sy + .5) / SS) * 512 / S;
        const d = Math.hypot(x - 256, y - 100) / 460;
        let c = mix([35, 42, 80], [13, 16, 32], Math.min(1, d));
        if (Math.hypot(x - 256, y - 230) < 150 && Math.hypot(x - 326, y - 186) >= 130) {
          const t = Math.min(1, Math.hypot(x - 200, y - 180) / 200);
          c = mix([255, 246, 216], [217, 184, 106], t);
        }
        if (inTri(x, y) || y > 430 && x > 96 && x < 416) c = [7, 9, 20];
        r += c[0]; g += c[1]; b += c[2];
      }
      const o = j * (S * 4 + 1) + 1 + i * 4, n = SS * SS;
      px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [192, 512]) writeFileSync(new URL(`../icons/icon-${s}.png`, import.meta.url), draw(s));
console.log('icônes générées');
