const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    // node_modules deps are kept external (real `require()`, resolved from
    // the extension's own node_modules at runtime) rather than bundled --
    // several (oxigraph, eyereasoner/swipl-wasm, @viz-js/viz, shacl-engine's
    // dependency tree) load .wasm/native assets via paths relative to their
    // own package directory, which bundling would break.
    packages: 'external',
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
