import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSvgToPng, renderSvgToImage } from './pngRenderer';

const EXTENSION_PATH = path.resolve(__dirname, '../..');

describe('renderSvgToPng', () => {
  it('rasterizes a real SVG to a valid PNG buffer', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="lightblue"/><text x="10" y="30">Hi</text></svg>';
    const png = await renderSvgToPng(svg, EXTENSION_PATH);
    expect(png.length).toBeGreaterThan(0);
    // PNG signature: \x89PNG\r\n\x1a\n
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('actually renders text glyphs, not just a valid-but-blank PNG', async () => {
    // Regression test: resvg-wasm's `loadSystemFonts: true` default silently produces zero
    // rendered glyphs in this Node/WASM context (no OS font-enumeration API is available to
    // WASM the way native resvg-js's fontdb has) -- text disappears with no error, while
    // shapes/colors/borders still render fine. Only a real pixel-content check catches this;
    // a PNG-signature-only check (as this test originally had) does not.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="white"/><text x="10" y="40" font-size="28" fill="black">Rex</text></svg>';
    const rendered = await renderSvgToImage(svg, EXTENSION_PATH);

    let darkPixels = 0;
    for (let i = 0; i < rendered.pixels.length; i += 4) {
      if (rendered.pixels[i] < 128 && rendered.pixels[i + 1] < 128 && rendered.pixels[i + 2] < 128) darkPixels++;
    }
    expect(darkPixels).toBeGreaterThan(20); // real glyph strokes, not an empty white rectangle
  });

  it('still renders shapes and colors correctly (not a font-only regression check)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="rgb(0,0,255)"/></svg>';
    const rendered = await renderSvgToImage(svg, EXTENSION_PATH);
    let bluePixels = 0;
    for (let i = 0; i < rendered.pixels.length; i += 4) {
      if (rendered.pixels[i] === 0 && rendered.pixels[i + 1] === 0 && rendered.pixels[i + 2] === 255) bluePixels++;
    }
    expect(bluePixels).toBe(rendered.pixels.length / 4); // the whole 40x40 canvas is the blue rect
  });
});
