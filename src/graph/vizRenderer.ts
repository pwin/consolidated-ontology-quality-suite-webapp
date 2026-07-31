interface VizInstance {
  renderString(input: string, options?: { format?: string; engine?: string }): string;
}
let vizInstance: VizInstance | undefined;

/**
 * Renders DOT to an SVG string using the actual `@viz-js/viz` WASM
 * package (not a vendored asm.js global script, unlike turtle-editor-
 * viewer) -- run here in the extension host (a Node process already
 * separate from VS Code's UI/renderer process), so Graphviz layout never
 * blocks the editor UI even without an additional Worker.
 */
export async function renderDotToSvg(dot: string): Promise<string> {
  if (!vizInstance) {
    const { instance } = await import('@viz-js/viz');
    vizInstance = await instance();
  }
  return vizInstance.renderString(dot, { format: 'svg' });
}
