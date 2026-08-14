import * as fs from 'node:fs';
import { Quad, Writer } from 'n3';
import { localName, Registry } from './registryLoader';
import type { ResultRow, Severity } from '../types';

const SEVERITY_LABEL: Record<string, Severity> = {
  'http://www.w3.org/ns/shacl#Violation': 'Violation',
  'http://www.w3.org/ns/shacl#Warning': 'Warning',
  'http://www.w3.org/ns/shacl#Info': 'Info',
};

/** One result as `shacl-wasm` hands it back -- see resources/shacl-wasm/shacl_wasm.d.ts. */
interface WasmResult {
  focusNode: string;
  path: string | null;
  value: string | null;
  severity: string;
  sourceShape: string | null;
  component: string;
  message: string;
}

interface WasmValidator {
  validateTurtle(text: string, base?: string | null, inference?: string | null): { results: WasmResult[] };
}

interface WasmModule {
  Validator: { fromTurtle(text: string, base?: string | null): WasmValidator };
}

/** Shapes-file path -> its compiled Validator. Compiling is the expensive half; the shapes never change within a session. */
const cachedValidators = new Map<string, WasmValidator>();

// The data graph is handed over as N-Triples rather than Turtle: the engine
// parses either, but N-Triples needs no prefix table, so nothing here depends on
// the prefixes a merged graph happens to carry.
const DATA_BASE = 'http://ontology-dev-suite.local/data/';

/**
 * Runs the registry's shapes/*.ttl (SHACL-SPARQL shapes named `oq:<CHECK-ID>`,
 * mirroring consolidated_ontology_suite's own runner) via
 * **`shacl-wasm-node`** -- a WebAssembly build of the native Rust SHACL engine
 * (https://github.com/pwin/SHACL_Engine). It is the CommonJS build of the pair
 * that engine publishes; `shacl-wasm` is the ESM one, for bundlers.
 *
 * **Replaces `shacl-engine`** (the pure-JS engine used through v0.9.3), which
 * had two defects this engine does not, both confirmed against these exact
 * shapes rather than taken on trust:
 *
 * - `shapes/data.ttl` and `shapes/efficiency.ttl` threw `Tried to bind variable
 *   ?this in a GROUP BY operator`, losing every check in both files -- so
 *   `DAT-001`/`EFF-002` could never fire through the SHACL path at all. All six
 *   shapes files now compile and run.
 * - It silently dropped an `sh:severity` declared inside an `sh:sparql` block,
 *   reporting everything as `sh:Violation`; v0.9.2 worked around that by reading
 *   the declared severity out of the shapes graph here. The workaround is gone:
 *   this engine reports the declared severity itself.
 *
 * It is also dramatically faster on the same work -- 324ms against 71,237ms for
 * the six shapes files over `examples/ontology/domain.ttl`, producing an
 * identical 11 findings with identical severities. That difference is why
 * `enableShaclChecks` is no longer the toggle worth reaching for.
 *
 * Per-file isolation is kept: a shapes file that fails to compile costs only its
 * own checks, not the whole run.
 */
export function runShaclChecks(quads: Quad[], registry: Registry): ResultRow[] {
  let dataText: string;
  try {
    dataText = toNTriples(quads);
  } catch (err) {
    console.error('[ontologySuite] could not serialize the graph for SHACL validation:', err);
    return [];
  }

  const rows: ResultRow[] = [];
  for (const file of registry.shaclFiles) {
    const validator = getOrBuildValidator(file);
    if (!validator) continue;
    try {
      const report = validator.validateTurtle(dataText, DATA_BASE, 'none');
      rows.push(...toResultRows(report.results, registry));
    } catch (err) {
      console.error(`[ontologySuite] shacl-wasm failed validating against ${file}:`, err);
    }
  }
  return rows;
}

function toResultRows(results: WasmResult[], registry: Registry): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const result of results) {
    // The registry's shapes are named `oq:<CHECK-ID>`, so the shape IRI's local
    // name is the check id. A finding from a nested (blank-node) property shape
    // has no such name; it keeps a null checkId and the generic message below,
    // exactly as the previous engine's results did.
    const checkId = result.sourceShape ? localName(result.sourceShape) : null;
    const check = checkId ? registry.checksById.get(checkId) : undefined;

    rows.push({
      checkId: check ? checkId : null,
      category: check?.category ?? null,
      title: check?.title ?? null,
      severity: SEVERITY_LABEL[result.severity] ?? 'Info',
      focusNode: result.focusNode,
      path: result.path,
      value: result.value ?? result.focusNode,
      message: result.message || (check ? `Violates ${checkId}.` : 'SHACL validation failed.'),
      remediation: check?.remediation ?? null,
      sources: ['shacl'],
    });
  }
  return rows;
}

function getOrBuildValidator(file: string): WasmValidator | undefined {
  const cached = cachedValidators.get(file);
  if (cached) return cached;

  let shapesText: string;
  try {
    shapesText = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[ontologySuite] failed to read shapes file ${file}:`, err);
    return undefined;
  }

  let mod: WasmModule;
  try {
    // Imported lazily, and left as a real runtime `require` by esbuild's
    // `packages: 'external'` -- its wasm-bindgen shim reads the .wasm from its
    // own package directory, which bundling would break. Same arrangement as
    // oxigraph and eyereasoner.
    mod = require('shacl-wasm-node') as WasmModule;
  } catch (err) {
    console.error('[ontologySuite] could not load shacl-wasm-node; SHACL checks are unavailable:', err);
    return undefined;
  }

  try {
    const validator = mod.Validator.fromTurtle(shapesText, DATA_BASE);
    cachedValidators.set(file, validator);
    return validator;
  } catch (err) {
    console.error(`[ontologySuite] failed to compile shapes file ${file}:`, err);
    return undefined;
  }
}

/**
 * N3's Writer in N-Triples mode. Every term is written out in full, so the
 * engine sees the same graph regardless of what prefixes the merged document
 * used -- and blank node labels stay stable across the hand-off.
 */
function toNTriples(quads: Quad[]): string {
  const writer = new Writer({ format: 'N-Triples' });
  writer.addQuads(quads);
  let out = '';
  let failure: Error | undefined;
  // The callback form is synchronous for an in-memory writer, which is what
  // lets runShaclChecks stay synchronous for its callers.
  writer.end((err, result) => {
    if (err) failure = err;
    else out = result;
  });
  if (failure) throw failure;
  return out;
}
