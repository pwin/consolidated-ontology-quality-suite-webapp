// Build steps for the TypeScript server plugin that types a user's `.ontology.ts` script
// (src/scripting/tsPlugin.ts). esbuild.js runs them on every build; tsPlugin.test.ts runs them
// into a temporary directory laid out like an installed extension.
//
// Run Ontology Script supplies `ontology-suite/dsl` at run time (scriptRunnerEntry.ts), but the
// editor's TypeScript service has no way to find that module, so without the plugin every script
// shows "Cannot find module 'ontology-suite/dsl'" and the DSL is typed as `any`.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const PLUGIN_NAME = 'ontology-suite-ts-plugin';
const SRC = path.join(__dirname, 'src');

/**
 * Writes declarations for scripting/dsl.ts, and for the files its types come from, under
 * `outDir` (scripting/dsl.d.ts is the one the plugin resolves the import to).
 *
 * Those types include n3's Quad and Term, which in this repo come from the ambient
 * `declare module 'n3'` in src/types-n3.d.ts. The declarations import them from a module copy
 * of it, n3.d.ts, instead: shipped as it is, that ambient declaration would apply to every file
 * in the user's project and collide with any n3 typings of their own.
 */
function writeDslTypes(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const options = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    // No @types: a DSL type that needed Node's would need it in the user's project too.
    types: [],
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: SRC,
    outDir,
  };
  const program = ts.createProgram([path.join(SRC, 'scripting', 'dsl.ts'), path.join(SRC, 'types-n3.d.ts')], options);
  const emitted = program.emit(undefined, undefined, undefined, true, { afterDeclarations: [importN3Relatively] });
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => __dirname, getNewLine: () => '\n' }),
    );
  }
  fs.writeFileSync(path.join(outDir, 'n3.d.ts'), n3AsModule());
}

/** Points each `'n3'` import in a declaration file at the n3.d.ts written next to it. */
function importN3Relatively(context) {
  const f = context.factory;
  return (file) => {
    if (!ts.isSourceFile(file)) return file;
    const source = ts.getOriginalNode(file).fileName;
    const relative = path.relative(path.dirname(source), path.join(SRC, 'n3')).replace(/\\/g, '/');
    const specifier = () => f.createStringLiteral(relative.startsWith('.') ? relative : `./${relative}`);
    const isN3 = (node) => node !== undefined && ts.isStringLiteral(node) && node.text === 'n3';
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && isN3(node.moduleSpecifier)) {
        return f.updateImportDeclaration(node, node.modifiers, node.importClause, specifier(), node.attributes);
      }
      if (ts.isExportDeclaration(node) && isN3(node.moduleSpecifier)) {
        return f.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, specifier(), node.attributes);
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isN3(node.argument.literal)) {
        const updated = f.updateImportTypeNode(node, f.createLiteralTypeNode(specifier()), node.attributes, node.qualifier, node.typeArguments, node.isTypeOf);
        return ts.visitEachChild(updated, visit, context);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit);
  };
}

/** src/types-n3.d.ts's `declare module 'n3' { ... }`, as the body of a module file. */
function n3AsModule() {
  const file = path.join(SRC, 'types-n3.d.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const n3 = source.statements.find((s) => ts.isModuleDeclaration(s) && ts.isStringLiteral(s.name) && s.name.text === 'n3');
  if (!n3 || !n3.body || !ts.isModuleBlock(n3.body)) throw new Error(`${file} no longer declares module 'n3'`);
  const { statements } = n3.body;
  const body = source.text.slice(statements.pos, statements.end).trim().replace(/^ {2}/gm, '');
  return `// Generated from src/types-n3.d.ts by ts-plugin-build.js.\n${body}\n`;
}

/**
 * VS Code gives tsserver a plugin by package name, and tsserver `require`s it from
 * `<extension>/node_modules/<name>`, so the plugin has to be a package there. This writes one
 * that loads the real plugin from dist/. It is not a dependency in package.json -- it would have
 * to be published or linked to be -- but vsce ships it all the same, since `npm ls` lists every
 * package in node_modules; package-vsix.mjs checks that it did. An `npm install` can remove it,
 * and the next build writes it back.
 */
function writePluginShim(extensionRoot) {
  const dir = path.join(extensionRoot, 'node_modules', PLUGIN_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { name: PLUGIN_NAME, version: '0.0.0', private: true, main: 'index.js' };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "// Written by ts-plugin-build.js; see writePluginShim there.\nmodule.exports = require('../../dist/tsPlugin.js').init;\n",
  );
}

module.exports = { PLUGIN_NAME, writeDslTypes, writePluginShim };
