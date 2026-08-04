import * as fs from 'node:fs/promises';
import * as path from 'node:path';

let wasmInitialized: Promise<void> | undefined;
let fontBufferCache: Promise<Uint8Array> | undefined;

/**
 * Rasterizes an SVG string to PNG bytes via `@resvg/resvg-wasm` -- the WASM
 * sibling of `@resvg/resvg-js` (a native N-API binding this project tried
 * once for the README's graph image and deliberately didn't keep as a
 * dependency, presumably for the same cross-platform-native-binary reason
 * every other engine here -- Oxigraph, shacl-engine, eyereasoner,
 * @viz-js/viz -- is WASM instead). Graphviz's own WASM build
 * (graph/vizRenderer.ts) has no PNG output at all (confirmed: `renderString`
 * only accepts vector/text formats -- svg, dot, json, ps, eps, ... -- no
 * rasterization plugin is compiled in), so PNG needs this second, separate
 * rasterization step.
 *
 * A font must be supplied explicitly. `font.loadSystemFonts` defaults to
 * true, but confirmed empirically that it finds nothing in this WASM/Node
 * context (no OS font-enumeration API is available to WASM the way native
 * resvg-js's fontdb has) -- text silently renders as zero pixels with no
 * error, while shapes/colors/borders all render correctly (verified
 * separately: a solid rect renders 100% of its expected fill pixels, a
 * stroke renders its exact color, only glyphs are missing). `resources/
 * fonts/roboto-latin-400-normal.woff2` (SIL OFL 1.1, license text
 * alongside it) is bundled specifically to fix this -- confirmed resvg's
 * underlying font parser accepts WOFF2 directly, no need for a raw TTF/OTF.
 */
/** Renders and returns resvg's own RenderedImage (PNG bytes via .asPng(), raw RGBA via .pixels) -- split out from renderSvgToPng so tests can inspect actual pixel content, not just PNG validity. */
export async function renderSvgToImage(svg: string, extensionPath: string) {
  if (!wasmInitialized) {
    wasmInitialized = (async () => {
      const { initWasm } = await import('@resvg/resvg-wasm');
      const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
      const wasmBytes = await fs.readFile(wasmPath);
      await initWasm(wasmBytes);
    })();
  }
  await wasmInitialized;

  if (!fontBufferCache) {
    fontBufferCache = fs.readFile(path.join(extensionPath, 'resources', 'fonts', 'roboto-latin-400-normal.woff2'));
  }
  const fontBuffer = await fontBufferCache;

  const { Resvg } = await import('@resvg/resvg-wasm');
  const resvg = new Resvg(svg, {
    background: 'white',
    font: {
      fontBuffers: [fontBuffer],
      loadSystemFonts: false,
      defaultFontFamily: 'Roboto',
      sansSerifFamily: 'Roboto',
    },
  });
  return resvg.render();
}

export async function renderSvgToPng(svg: string, extensionPath: string): Promise<Buffer> {
  const rendered = await renderSvgToImage(svg, extensionPath);
  return Buffer.from(rendered.asPng());
}
