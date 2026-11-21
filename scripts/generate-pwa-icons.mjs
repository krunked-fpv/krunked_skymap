import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(SCRIPT_DIR, '../public/icons');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  if (data.length > 0) {
    data.copy(chunk, 8);
  }
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} RGBA bytes, received ${rgba.length}`);
  }

  const stride = width * 4;
  const rawScanlines = Buffer.allocUnsafe(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + stride);
    rawScanlines[rowStart] = 0; // PNG filter type 0 (None)
    const srcOffset = y * stride;
    rawScanlines.set(rgba.subarray(srcOffset, srcOffset + stride), rowStart + 1);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // Deflate compression
  ihdr[11] = 0; // Adaptive filtering
  ihdr[12] = 0; // Non-interlaced

  const compressed = deflateSync(rawScanlines, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function blendOver(baseR, baseG, baseB, fgR, fgG, fgB, alpha) {
  const a = clamp01(alpha);
  const inv = 1 - a;
  return [
    baseR * inv + fgR * a,
    baseG * inv + fgG * a,
    baseB * inv + fgB * a,
  ];
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 0) return Math.hypot(px - x1, py - y1);
  const t = clamp01(((px - x1) * vx + (py - y1) * vy) / lenSq);
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
}

function normalizeAngleDiff(targetRad, currentRad) {
  let diff = targetRad - currentRad;
  while (diff < 0) diff += Math.PI * 2;
  while (diff >= Math.PI * 2) diff -= Math.PI * 2;
  return diff;
}

function renderSkyMapIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const cx = size * 0.5;
  const cy = size * 0.5;

  // Maskable safe-zone geometry: core elements stay cleanly inside 76% diameter (r <= 0.38 * size)
  const dishRadius = size * 0.375;
  const horizonRadius = size * 0.35;
  const orbitalRadius = size * 0.212;
  const innerRangeRadius = size * 0.112;

  const horizonHalfStroke = Math.max(1.15, size * 0.0115);
  const orbitalHalfStroke = Math.max(0.95, size * 0.0085);
  const beamHalfStroke = Math.max(1.05, size * 0.0105);
  const axisHalfStroke = Math.max(0.55, size * 0.0028);

  const beamAngle = (-42 * Math.PI) / 180;
  const sweepSpan = (68 * Math.PI) / 180;
  const beamEndX = cx + Math.cos(beamAngle) * horizonRadius;
  const beamEndY = cy + Math.sin(beamAngle) * horizonRadius;

  const blipAngle = (-66 * Math.PI) / 180;
  const blipRadius = horizonRadius * 0.74;
  const blipX = cx + Math.cos(blipAngle) * blipRadius;
  const blipY = cy + Math.sin(blipAngle) * blipRadius;
  const blipDotR = Math.max(1.8, size * 0.022);
  const blipCoreR = Math.max(1.0, size * 0.011);
  const blipHaloR = Math.max(4.0, size * 0.056);

  const zenithDotR = Math.max(2.1, size * 0.025);
  const zenithCoreR = Math.max(0.9, size * 0.01);
  const zenithHaloR = Math.max(4.2, size * 0.06);

  const aaWidth = 0.85;
  const subSamples = 4;
  const invSamples = 1 / (subSamples * subSamples);

  // Palette constants
  const bgR = 6;
  const bgG = 9;
  const bgB = 15;

  const dishCenterR = 16;
  const dishCenterG = 33;
  const dishCenterB = 56;

  const dishEdgeR = 13;
  const dishEdgeG = 25;
  const dishEdgeB = 43;

  const cyanR = 34;
  const cyanG = 211;
  const cyanB = 238;

  const violetR = 192;
  const violetG = 132;
  const violetB = 252;

  const zenithR = 56;
  const zenithG = 189;
  const zenithB = 248;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let accR = 0;
      let accG = 0;
      let accB = 0;

      for (let sy = 0; sy < subSamples; sy += 1) {
        const py = y + (sy + 0.5) / subSamples;
        const dy = py - cy;

        for (let sx = 0; sx < subSamples; sx += 1) {
          const px = x + (sx + 0.5) / subSamples;
          const dx = px - cx;
          const dist = Math.hypot(dx, dy);

          // 1. Base #06090F obsidian background
          let r = bgR;
          let g = bgG;
          let b = bgB;

          // 2. Subtle #0D192B radar dish gradient inside 76% safe zone
          if (dist < dishRadius + aaWidth) {
            const dishMask = 1 - smoothstep(dishRadius - aaWidth, dishRadius + aaWidth, dist);
            const t = clamp01(dist / dishRadius);
            const radialFalloff = Math.pow(1 - t, 1.35);
            const dishR = dishEdgeR + (dishCenterR - dishEdgeR) * radialFalloff;
            const dishG = dishEdgeG + (dishCenterG - dishEdgeG) * radialFalloff;
            const dishB = dishEdgeB + (dishCenterB - dishEdgeB) * radialFalloff;
            [r, g, b] = blendOver(r, g, b, dishR, dishG, dishB, dishMask * (0.35 + 0.65 * radialFalloff));
          }

          // 3. Faint radar range ring & cardinal crosshairs inside horizon ring
          if (dist < horizonRadius) {
            const innerDist = Math.abs(dist - innerRangeRadius);
            if (innerDist < axisHalfStroke + aaWidth) {
              const alpha =
                0.18 * (1 - smoothstep(axisHalfStroke - aaWidth * 0.5, axisHalfStroke + aaWidth, innerDist));
              [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, alpha);
            }

            const axisDist = Math.min(Math.abs(dx), Math.abs(dy));
            if (axisDist < axisHalfStroke + aaWidth && dist > zenithDotR * 1.4) {
              const axisAlpha =
                0.14 *
                (1 - smoothstep(axisHalfStroke - aaWidth * 0.5, axisHalfStroke + aaWidth, axisDist)) *
                (1 - smoothstep(horizonRadius * 0.9, horizonRadius, dist));
              [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, axisAlpha);
            }
          }

          // 4. Cyan phosphor sweep wedge trailing counter-clockwise behind the beam
          if (dist <= horizonRadius + aaWidth && dist > 0.5) {
            const angle = Math.atan2(dy, dx);
            const lag = normalizeAngleDiff(beamAngle, angle);
            if (lag >= 0 && lag <= sweepSpan) {
              const angularIntensity = Math.pow(1 - lag / sweepSpan, 2.15);
              const radialFactor = 0.45 + 0.55 * clamp01(dist / horizonRadius);
              const clipMask = 1 - smoothstep(horizonRadius - aaWidth, horizonRadius + aaWidth, dist);
              const wedgeAlpha = 0.36 * angularIntensity * radialFactor * clipMask;
              [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, wedgeAlpha);
            }
          }

          // 5. #C084FC orbital ring with soft violet halo
          const orbRingDist = Math.abs(dist - orbitalRadius);
          if (orbRingDist < orbitalHalfStroke * 3.5 + aaWidth) {
            const glowAlpha =
              0.16 * (1 - smoothstep(orbitalHalfStroke, orbitalHalfStroke * 3.5 + aaWidth, orbRingDist));
            const coreAlpha =
              0.88 * (1 - smoothstep(orbitalHalfStroke - aaWidth * 0.5, orbitalHalfStroke + aaWidth, orbRingDist));
            [r, g, b] = blendOver(r, g, b, violetR, violetG, violetB, glowAlpha);
            [r, g, b] = blendOver(r, g, b, violetR, violetG, violetB, coreAlpha);
          }

          // 6. Anti-aliased #22D3EE cyan horizon ring with soft phosphor glow
          const horRingDist = Math.abs(dist - horizonRadius);
          if (horRingDist < horizonHalfStroke * 3.8 + aaWidth) {
            const glowAlpha =
              0.22 * (1 - smoothstep(horizonHalfStroke, horizonHalfStroke * 3.8 + aaWidth, horRingDist));
            const coreAlpha =
              0.92 * (1 - smoothstep(horizonHalfStroke - aaWidth * 0.5, horizonHalfStroke + aaWidth, horRingDist));
            [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, glowAlpha);
            [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, coreAlpha);
          }

          // 7. Leading sweep beam from center to horizon ring
          const beamDist = distanceToSegment(px, py, cx, cy, beamEndX, beamEndY);
          if (beamDist < beamHalfStroke * 3.2 + aaWidth) {
            const glowAlpha =
              0.28 * (1 - smoothstep(beamHalfStroke, beamHalfStroke * 3.2 + aaWidth, beamDist));
            const coreAlpha =
              0.96 * (1 - smoothstep(beamHalfStroke - aaWidth * 0.5, beamHalfStroke + aaWidth, beamDist));
            const highlightAlpha =
              0.55 * (1 - smoothstep(0, beamHalfStroke * 0.75, beamDist));
            [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, glowAlpha);
            [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, coreAlpha);
            [r, g, b] = blendOver(r, g, b, 186, 246, 255, highlightAlpha);
          }

          // 8. Bright target blip inside the swept quadrant
          const blipDist = Math.hypot(px - blipX, py - blipY);
          if (blipDist < blipHaloR) {
            const haloAlpha = 0.45 * Math.pow(1 - clamp01(blipDist / blipHaloR), 2.1);
            [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, haloAlpha);
            if (blipDist < blipDotR + aaWidth) {
              const dotAlpha = 1 - smoothstep(blipDotR - aaWidth, blipDotR + aaWidth, blipDist);
              [r, g, b] = blendOver(r, g, b, cyanR, cyanG, cyanB, dotAlpha);
            }
            if (blipDist < blipCoreR + aaWidth) {
              const coreAlpha = 1 - smoothstep(blipCoreR - aaWidth, blipCoreR + aaWidth, blipDist);
              [r, g, b] = blendOver(r, g, b, 240, 253, 255, coreAlpha);
            }
          }

          // 9. #38BDF8 center zenith dot
          if (dist < zenithHaloR) {
            const haloAlpha = 0.35 * Math.pow(1 - clamp01(dist / zenithHaloR), 2.2);
            [r, g, b] = blendOver(r, g, b, zenithR, zenithG, zenithB, haloAlpha);
            if (dist < zenithDotR + aaWidth) {
              const dotAlpha = 1 - smoothstep(zenithDotR - aaWidth, zenithDotR + aaWidth, dist);
              [r, g, b] = blendOver(r, g, b, zenithR, zenithG, zenithB, dotAlpha);
            }
            if (dist < zenithCoreR + aaWidth) {
              const coreAlpha = 1 - smoothstep(zenithCoreR - aaWidth, zenithCoreR + aaWidth, dist);
              [r, g, b] = blendOver(r, g, b, 224, 242, 254, 0.85 * coreAlpha);
            }
          }

          accR += r;
          accG += g;
          accB += b;
        }
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(accR * invSamples);
      rgba[idx + 1] = Math.round(accG * invSamples);
      rgba[idx + 2] = Math.round(accB * invSamples);
      rgba[idx + 3] = 255;
    }
  }

  return encodePng(size, size, rgba);
}

const TARGET_ICONS = [
  { filename: 'icon-192.png', size: 192 },
  { filename: 'icon-512.png', size: 512 },
  { filename: 'apple-touch-icon.png', size: 180 },
];

async function main() {
  await mkdir(ICONS_DIR, { recursive: true });
  for (const { filename, size } of TARGET_ICONS) {
    const pngBuffer = renderSkyMapIcon(size);
    const outPath = path.join(ICONS_DIR, filename);
    await writeFile(outPath, pngBuffer);
    console.log(`[pwa-icons] wrote ${size}x${size} (${pngBuffer.length} bytes) -> ${outPath}`);
  }
}

await main();
