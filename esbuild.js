const path = require('node:path');
const esbuild = require('esbuild');
const { writeDslTypes, writePluginShim } = require('./ts-plugin-build');

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

// The declarations the editor types `ontology-suite/dsl` against (see ts-plugin-build.js),
// regenerated whenever dsl.js is, so that in watch mode they follow the DSL as it changes.
const dslTypes = {
  name: 'dsl-types',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) writeDslTypes(path.join(__dirname, 'dist', 'dsl-types'));
    });
  },
};

async function main() {
  writePluginShim(__dirname);
  const contexts = await Promise.all([
    esbuild.context({ ...sharedOptions, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
    // scripting/dsl.ts and scripting/scriptRunnerEntry.ts are built as their own standalone
    // bundles, separate from extension.js: scriptRunnerEntry.ts runs in a forked child process
    // (see runScript.ts), not the extension host, and dsl.ts needs to exist as a real file on
    // disk at a stable path so a user's `.ontology.ts` script's `require('ontology-suite/dsl')`
    // (resolved via scriptRunnerEntry.ts's Module._resolveFilename patch) and this runner's own
    // `require('./dsl')` resolve to the exact same path -- and therefore the same Node
    // require-cache module instance -- both are essential, not just packaging convenience.
    esbuild.context({ ...sharedOptions, entryPoints: ['src/scripting/dsl.ts'], outfile: 'dist/dsl.js', plugins: [dslTypes] }),
    esbuild.context({ ...sharedOptions, entryPoints: ['src/scripting/scriptRunnerEntry.ts'], outfile: 'dist/scriptRunnerEntry.js' }),
    // Loaded by VS Code's TypeScript server, not the extension host: see ts-plugin-build.js.
    esbuild.context({ ...sharedOptions, entryPoints: ['src/scripting/tsPlugin.ts'], outfile: 'dist/tsPlugin.js' }),
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
