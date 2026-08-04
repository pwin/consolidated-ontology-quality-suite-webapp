const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  // node_modules deps are kept external (real `require()`, resolved from
  // the extension's own node_modules at runtime) rather than bundled --
  // several (oxigraph, eyereasoner/swipl-wasm, @viz-js/viz, shacl-engine's
  // dependency tree) load .wasm/native assets via paths relative to their
  // own package directory, which bundling would break.
  packages: 'external',
  logLevel: 'info',
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context({ ...sharedOptions, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
    // scripting/dsl.ts and scripting/scriptRunnerEntry.ts are built as their own standalone
    // bundles, separate from extension.js: scriptRunnerEntry.ts runs in a forked child process
    // (see runScript.ts), not the extension host, and dsl.ts needs to exist as a real file on
    // disk at a stable path so a user's `.ontology.ts` script's `require('ontology-suite/dsl')`
    // (resolved via scriptRunnerEntry.ts's Module._resolveFilename patch) and this runner's own
    // `require('./dsl')` resolve to the exact same path -- and therefore the same Node
    // require-cache module instance -- both are essential, not just packaging convenience.
    esbuild.context({ ...sharedOptions, entryPoints: ['src/scripting/dsl.ts'], outfile: 'dist/dsl.js' }),
    esbuild.context({ ...sharedOptions, entryPoints: ['src/scripting/scriptRunnerEntry.ts'], outfile: 'dist/scriptRunnerEntry.js' }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
