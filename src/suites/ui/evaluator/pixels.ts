/**
 * Pixel-level helpers over Playwright PNG screenshot buffers: change
 * percentage (pixelmatch), blank-frame detection, and dominant-hue shift.
 * These work on the COMPOSITED page output, so WebGL content is fully
 * visible — unlike the legacy 2D-getImageData approach.
 */

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

export function decodePng(buffer: Buffer): DecodedPng {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Percentage of pixels that differ between two screenshots (0–100).
 * Size mismatch counts as fully changed.
 */
export function changedPixelPct(a: Buffer, b: Buffer, threshold = 0.1): number {
  const imgA = decodePng(a);
  const imgB = decodePng(b);
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) return 100;

  const changed = pixelmatch(imgA.data, imgB.data, null, imgA.width, imgA.height, { threshold });
  return (changed / (imgA.width * imgA.height)) * 100;
}

/**
 * True when a frame is near-uniform (a blank/black render). Samples every
 * 16th pixel and checks per-channel standard deviation.
 */
export function isBlankFrame(buffer: Buffer, stdDevThreshold = 4): boolean {
  const img = decodePng(buffer);
  const { data } = img;
  const stride = 16 * 4;
  let count = 0;
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];

  for (let i = 0; i < data.length; i += stride) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c]!;
      sum[c] = sum[c]! + v;
      sumSq[c] = sumSq[c]! + v * v;
    }
    count++;
  }

  if (count === 0) return true;

  for (let c = 0; c < 3; c++) {
    const mean = sum[c]! / count;
    const variance = sumSq[c]! / count - mean * mean;
    if (Math.sqrt(Math.max(variance, 0)) > stdDevThreshold) return false;
  }
  return true;
}

/**
 * Average hue (degrees, 0–360) of sufficiently saturated+bright pixels,
 * computed as a circular mean. Returns null when too few pixels qualify
 * (e.g. a grayscale frame).
 */
export function dominantHue(buffer: Buffer): number | null {
  const img = decodePng(buffer);
  const { data } = img;
  let sumSin = 0;
  let sumCos = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 8 * 4) {
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const sat = max === 0 ? 0 : delta / max;
    if (max < 0.15 || sat < 0.25) continue; // ignore dark / gray pixels

    let hue: number;
    if (delta === 0) continue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;

    const rad = (hue * Math.PI) / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
    count++;
  }

  if (count < 50) return null;
  const mean = (Math.atan2(sumSin / count, sumCos / count) * 180) / Math.PI;
  return mean < 0 ? mean + 360 : mean;
}

/** Circular distance between two hues in degrees (0–180). */
export function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Mean luminance (0–255) sampled every 8th pixel. */
export function meanLuminance(buffer: Buffer): number {
  const img = decodePng(buffer);
  const { data } = img;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 8 * 4) {
    sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    count++;
  }
  return count === 0 ? 0 : sum / count;
}
