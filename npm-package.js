// Builds the `ontology-suite` npm package: the scripting DSL on its own, so that
// `import ... from 'ontology-suite/dsl'` resolves after a plain `npm install` -- for type-checking
// scripts in CI or another editor, or running one under Node.
//
//   node npm-package.js     (or: npm run npm-package)
//
// writes dist-npm/ontology-suite and lists what `npm pack` would put in the tarball. Publishing is
// a separate step: `npm publish dist-npm/ontology-suite`.
//
// The package is built from the same source as the extension's DSL: dsl.js bundled with
// everything it uses (n3 included, so the package has no dependencies), and the declarations
// ts-plugin-build.js generates for the editor. When a script runs inside VS Code, the extension's
// own copy of the DSL runs it, whichever version of this package is installed.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const { writeDslTypes } = require('./ts-plugin-build');

const NAME = 'ontology-suite';
const manifest = require('./package.json');

/** The files a correct package holds; checked against `npm pack` by the CLI below and by the test. */
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dsl/package.json', 'dsl/index.js', 'dsl/types/scripting/dsl.d.ts', 'dsl/types/n3.d.ts'];

function buildNpmPackage(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'dsl'), { recursive: true });

  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'src', 'scripting', 'dsl.ts')],
    outfile: path.join(outDir, 'dsl', 'index.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    // n3's ES-module build, which esbuild can trim to the DataFactory the DSL uses: 44 KB, where
    // its CommonJS build brings its parser, store and streams too, at 413 KB.
    mainFields: ['module', 'main'],
    logLevel: 'silent',
  });
  writeDslTypes(path.join(outDir, 'dsl', 'types'));

  const types = './dsl/types/scripting/dsl.d.ts';
  const pkg = {
    name: NAME,
    version: manifest.version,
    description: 'Write OWL ontologies as TypeScript: the scripting DSL of the Ontology Development Suite VS Code extension.',
    keywords: ['owl', 'ontology', 'rdf', 'turtle', 'dsl', 'manchester-syntax', 'semantic-web'],
    license: manifest.license,
    author: 'pwin <pw@inbox.lv>',
    repository: manifest.repository,
    homepage: 'https://github.com/pwin/consolidated-ontology-quality-suite-webapp#readme',
    bugs: 'https://github.com/pwin/consolidated-ontology-quality-suite-webapp/issues',
    // The DSL keeps the ontology being built in module state, so the module must load once.
    sideEffects: true,
    engines: { node: '>=18' },
    exports: {
      './dsl': { types, default: './dsl/index.js' },
      './package.json': './package.json',
    },
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  // For resolvers that predate `exports` -- TypeScript's node10 resolution among them.
  fs.writeFileSync(path.join(outDir, 'dsl', 'package.json'), `${JSON.stringify({ main: 'index.js', types: 'types/scripting/dsl.d.ts' }, null, 2)}\n`);
  fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(outDir, 'LICENSE'));
  fs.copyFileSync(path.join(__dirname, 'resources', 'npm', 'README.md'), path.join(outDir, 'README.md'));
  return outDir;
}

/** The paths `npm pack` would put in the tarball for the package at `dir`. */
function packedFiles(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

module.exports = { NAME, REQUIRED, buildNpmPackage, packedFiles };

if (require.main === module) {
  const dir = buildNpmPackage(path.join(__dirname, 'dist-npm', NAME));
  const files = packedFiles(dir);
  const missing = REQUIRED.filter((f) => !files.includes(f));
  if (missing.length) {
    console.error(`${NAME}@${manifest.version} is missing:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`${NAME}@${manifest.version} — ${files.length} files in ${path.relative(__dirname, dir)}:`);
  for (const f of files) console.log(`  ${f}`);
}
