/**
 * TypeScript server plugin that types a user's `.ontology.ts` script. Run Ontology Script
 * supplies `ontology-suite/dsl` only at run time (scriptRunnerEntry.ts patches Node's resolver),
 * so the editor's TypeScript service can't find the module: every script would show "Cannot
 * find module 'ontology-suite/dsl'", and the DSL would be typed as `any`.
 *
 * package.json's `typescriptServerPlugins` has VS Code load this into its TypeScript server for
 * every workspace, whether or not this extension has activated, so it does one thing: when
 * TypeScript fails to resolve `ontology-suite/dsl`, it resolves it to the declarations
 * ts-plugin-build.js generates into dist/dsl-types. Every other import, and an
 * `ontology-suite/dsl` that TypeScript did resolve (a tsconfig `paths` entry, say), is left as
 * TypeScript found it.
 */
import * as path from 'node:path';
import type * as ts from 'typescript';

const SPECIFIER = 'ontology-suite/dsl';

/** `dslTypes` is the declaration file to resolve `ontology-suite/dsl` to. */
export function createPlugin(dslTypes: string): ts.server.PluginModuleFactory {
  return ({ typescript }) => ({
    create(info) {
      const host = info.languageServiceHost;
      // tsserver's host has implemented this since TypeScript 5.0. With an older workspace
      // TypeScript the plugin does nothing.
      const resolve = host.resolveModuleNameLiterals?.bind(host);
      if (!resolve) return info.languageService;
      const dsl: ts.ResolvedModuleFull = { resolvedFileName: dslTypes, extension: typescript.Extension.Dts, isExternalLibraryImport: true };
      host.resolveModuleNameLiterals = (literals, ...rest) =>
        resolve(literals, ...rest).map((r, i) => (r.resolvedModule || literals[i].text !== SPECIFIER ? r : { ...r, resolvedModule: dsl }));
      return info.languageService;
    },
  });
}

// tsserver calls the plugin package's export with `{ typescript }`; the package
// ts-plugin-build.js writes into node_modules re-exports this.
export const init = createPlugin(path.join(__dirname, 'dsl-types', 'scripting', 'dsl.d.ts'));
