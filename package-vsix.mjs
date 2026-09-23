// Builds the .vsix, then checks it actually contains the runtime assets.
//
//   node package-vsix.mjs        (or: npm run vsix)
//
// The flags matter and are easy to get wrong. `vsce package --no-dependencies`
// produces an archive that packages without error, installs without error, and
// is missing every engine the extension runs: esbuild is configured with
// `packages: 'external'`, so oxigraph, eyereasoner/swipl-wasm, shacl-wasm-node
// and @viz-js/viz are never bundled into dist/extension.js -- they are
// `require`d at runtime from node_modules, which .vscodeignore therefore ships
// on purpose. Without them Run Local Checks logs "could not load
// shacl-wasm-node" and silently offers fewer checks.
//
// A 590 KB vsix is the symptom; a correct one is around 19 MB. Rather than
// rely on noticing that, this asserts the specific files are present.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';

// Each engine, named by a file that must survive into the archive. A path
// rather than a package name: the point is that the asset is there, not that
// a directory with the right name is.
const REQUIRED = [
  'node_modules/shacl-wasm-node/shacl_wasm_bg.wasm',
  'node_modules/oxigraph/node_bg.wasm',
  'node_modules/swipl-wasm/dist/swipl/swipl-web.wasm',
];

for (const f of readdirSync('.').filter((n) => n.endsWith('.vsix'))) {
  unlinkSync(f);
}

execFileSync('npx', ['@vscode/vsce', 'package', '--allow-star-activation'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const vsix = readdirSync('.').find((n) => n.endsWith('.vsix'));
if (!vsix) {
  console.error('no .vsix was produced');
  process.exit(1);
}

// A zip stores each entry's name uncompressed, in the local header and again
// in the central directory, so searching the raw bytes is enough to answer
// "is this file in the archive" without unpacking it or taking a dependency.
const bytes = readFileSync(vsix);
const missing = REQUIRED.filter((p) => !bytes.includes(`extension/${p}`));

const mb = (bytes.length / 1048576).toFixed(1);
if (missing.length) {
  console.error(`\n${vsix} is ${mb} MB and is missing runtime assets:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error('\nThis is what `--no-dependencies` produces. The extension');
  console.error('loads these from node_modules at runtime; see .vscodeignore.');
  process.exit(1);
}

console.log(`\n${vsix} — ${mb} MB, all runtime assets present:`);
for (const p of REQUIRED) console.log(`  ${p.split('/').slice(1, -1).join('/')}`);
