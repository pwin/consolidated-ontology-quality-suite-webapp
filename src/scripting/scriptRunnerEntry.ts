/**
 * Child-process entry point for "Ontology Suite: Run Ontology Script" (see
 * runScript.ts, the extension-host side that forks this). Runs the user's
 * already-esbuild-transpiled `.ontology.ts` script in a separate OS process
 * -- a real process boundary, not just an isolated JS scope -- so a script
 * bug (infinite loop, uncaught throw, unexpected process.exit) can't take
 * down the extension host itself. This is process isolation for
 * robustness, not a security sandbox: the script runs with the same
 * filesystem/network access as any other Node process on this machine,
 * appropriate for a script you wrote yourself in your own workspace (the
 * same trust level as running any other npm script in this repo), not for
 * executing untrusted third-party code.
 *
 * Resolves the bare specifier `ontology-suite/dsl` (what a user script
 * imports to get defclass/defobjectproperty/some/only/... from) to this
 * extension's own bundled dsl.js by patching Node's module resolver before
 * requiring the user script -- both this file's own `require('./dsl')`
 * and the user script's `require('ontology-suite/dsl')` resolve to the
 * exact same absolute path, so Node's require cache guarantees they share
 * one dsl.ts module instance (and therefore one shared `current` builder
 * -- see dsl.ts). Without this, the user script and this runner would each
 * get their own independent copy of the DSL's module-level state, and
 * build() here would see an empty/undefined ontology.
 */
import * as path from 'node:path';
// TypeScript's CJS-interop import (not `import * as Module from 'node:module'`): esbuild wraps
// a plain ESM-namespace import of a CJS module in an interop shim that redefines its properties
// as getters, which breaks reassigning `_resolveFilename` below ("Cannot set property
// _resolveFilename ... which has only a getter") -- confirmed by hitting exactly that error.
// This form compiles to a plain `require('node:module')`, giving the real, mutable object.
import Module = require('node:module');
import type { Quad } from 'n3';

const dslPath = path.join(__dirname, 'dsl.js');

// `_resolveFilename` is an internal, undocumented Node API (not in @types/node) -- there is no
// public hook for "resolve this bare specifier to an arbitrary absolute path" as of this writing.
type InternalModule = { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const internalModule = Module as unknown as InternalModule;
const originalResolve = internalModule._resolveFilename;
internalModule._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'ontology-suite/dsl') return dslPath;
  return originalResolve.call(this, request, ...rest);
};

interface PlainQuad {
  s: string;
  sType: 'NamedNode' | 'BlankNode';
  p: string;
  o: string;
  oType: 'NamedNode' | 'BlankNode' | 'Literal';
  datatype?: string;
  language?: string;
}

function toPlainQuad(q: Quad): PlainQuad {
  const term = (t: Quad['subject'] | Quad['object']) => t.value;
  const base: PlainQuad = {
    s: term(q.subject),
    sType: q.subject.termType as 'NamedNode' | 'BlankNode',
    p: q.predicate.value,
    o: term(q.object),
    oType: q.object.termType as 'NamedNode' | 'BlankNode' | 'Literal',
  };
  if (q.object.termType === 'Literal') {
    const lit = q.object as import('n3').Literal;
    if (lit.language) base.language = lit.language;
    else base.datatype = lit.datatype.value;
  }
  return base;
}

async function main(): Promise<void> {
  const scriptPath = process.argv[2];
  if (!scriptPath) throw new Error('Usage: scriptRunnerEntry.js <path-to-transpiled-script.cjs>');

  require(scriptPath);
  const dsl = require(dslPath) as typeof import('./dsl');
  const { quads, prefixes } = dsl.build();

  process.send?.({ ok: true, quads: quads.map(toPlainQuad), prefixes });
  process.exitCode = 0;
}

main().catch((err) => {
  process.send?.({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  process.exitCode = 1;
});
