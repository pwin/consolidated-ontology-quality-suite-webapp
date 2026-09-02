import * as fs from 'node:fs';
import { DataFactory, Parser, Quad, Writer } from 'n3';
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

/**
 * `inference` selects what the engine materialises before validating:
 * `"none"` (what this runner asks for), `"rdfs"`, or -- since engine 0.1.9 --
 * `"rules"`/`"rules-iterated"` for SHACL-AF `sh:rule`. None of the registry's
 * shapes declare rules, and inference is the reasoner tier's job here
 * (checks/reasoningRunner.ts), so this deliberately stays at `"none"`: a
 * SHACL finding should be about what the document says, not about what a
 * second inference pass added underneath it.
 */
interface WasmValidator {
  validateTurtle(text: string, base?: string | null, inference?: string | null): { results: WasmResult[] };
}

/**
 * Only the `Validator` path is used, never the module-level `validateTurtle`
 * one-shot beside it -- shapes here are compiled once per session and validated
 * against many graphs, which is what that split is for.
 *
 * Worth stating because the two are diverging. The engine's 0.2.0 reorders the
 * one-shot's arguments from `(shapes, data)` to `(data, shapes)`, having found
 * that a transposed call silently *conformed*: the data compiles as a shapes
 * graph, declares no shapes, and validating against no shapes passes. The
 * `Validator` method's own signature is unchanged across 0.1.10, 0.1.12 and that
 * rework, so nothing here moves with it.
 */
interface WasmModule {
  Validator: { fromTurtle(text: string, base?: string | null): WasmValidator };
}

interface CompiledShapes {
  validator: WasmValidator;
  /** Shape IRI -- including the skolem IRIs minted below -- to the registry check id it reports as. */
  checkIdByShapeIri: Map<string, string>;
}

/** Shapes-file path -> its compiled shapes. Compiling is the expensive half; the shapes never change within a session. */
const cachedShapes = new Map<string, CompiledShapes>();

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
    const compiled = getOrBuildValidator(file, registry);
    if (!compiled) continue;
    try {
      const report = compiled.validator.validateTurtle(dataText, DATA_BASE, 'none');
      for (const r of toResultRows(report.results, registry, compiled.checkIdByShapeIri)) rows.push(r);
    } catch (err) {
      console.error(`[ontologySuite] shacl-wasm failed validating against ${file}:`, err);
    }
  }
  return rows;
}

function toResultRows(results: WasmResult[], registry: Registry, checkIdByShapeIri: Map<string, string>): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const result of results) {
    // The registry's shapes are named `oq:<CHECK-ID>`, so the shape IRI's local
    // name is usually the check id outright. Where it is not -- a nested property
    // shape, or a shape tagged with an `oq:checkId` annotation instead -- the map
    // built while compiling the shapes answers it (see nameNestedShapes).
    const direct = result.sourceShape ? localName(result.sourceShape) : null;
    const checkId = direct !== null && registry.checksById.has(direct)
      ? direct
      : result.sourceShape
        ? checkIdByShapeIri.get(result.sourceShape) ?? null
        : null;
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

function getOrBuildValidator(file: string, registry: Registry): CompiledShapes | undefined {
  const cached = cachedShapes.get(file);
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

  let named: { text: string; checkIdByShapeIri: Map<string, string> };
  try {
    named = nameNestedShapes(shapesText, registry);
  } catch (err) {
    // A shapes file this project cannot parse itself is still one the engine may
    // well compile, so fall back to the text as written rather than losing the file.
    console.error(`[ontologySuite] could not pre-name the nested shapes in ${file}:`, err);
    named = { text: shapesText, checkIdByShapeIri: new Map() };
  }

  try {
    const compiled: CompiledShapes = {
      validator: mod.Validator.fromTurtle(named.text, DATA_BASE),
      checkIdByShapeIri: named.checkIdByShapeIri,
    };
    cachedShapes.set(file, compiled);
    return compiled;
  } catch (err) {
    console.error(`[ontologySuite] failed to compile shapes file ${file}:`, err);
    return undefined;
  }
}

const SH_PROPERTY = 'http://www.w3.org/ns/shacl#property';
/** Where the skolem IRIs minted for nested property shapes live. They never leave this module. */
const SHAPE_SKOLEM_BASE = 'http://ontology-dev-suite.local/shape/';

/**
 * Gives every nested `sh:property [ ... ]` shape a real IRI before the file is
 * compiled, and returns the map from those IRIs back to the check id they belong to.
 *
 * A property-constraint result reports `sh:sourceShape` as the *nested* property
 * shape, not the enclosing `oq:<CHECK-ID>` node shape the id is readable from --
 * and a blank node has no name to read one from. So every finding from a check
 * written in native SHACL core (`DAT-004`, `LOG-001`, `LOG-003`, `QUA-009`,
 * `QUA-010`, `STR-002`) arrived with a null checkId: no title, no category, no
 * remediation, and no dedup key in common with its SPARQL twin, so both engines'
 * copies of one finding survived into the Problems panel.
 * `consolidated_ontology_suite_python` hit the same bug against pyshacl and fixed
 * it by walking up `sh:property` in the shapes graph
 * (`checks/registry.py::_resolve_shape_id`, step 4).
 *
 * Walking up needs the reported blank node to be findable in *our* parse of the
 * shapes, and it is not: `_:0_b6` and n3's `_:b6_...` are two parsers' private
 * labels for the same node, and nothing lines them up. Naming the shapes before
 * compiling sidesteps the mismatch -- the engine then reports the IRI minted here,
 * which is a key into a map built in the same pass.
 *
 * The same pass picks up `oq:checkId` annotations (step 3 upstream), which is how
 * the split shapes -- `QUA-001`, `STR-003`, `STY-002` -- are tagged.
 */
function nameNestedShapes(shapesText: string, registry: Registry): { text: string; checkIdByShapeIri: Map<string, string> } {
  const quads = new Parser().parse(shapesText);

  const parentOf = new Map<string, string>();
  const annotated = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value === SH_PROPERTY && q.object.termType === 'BlankNode') {
      parentOf.set(q.object.value, q.subject.value);
    }
    // Matched on local name rather than a fixed IRI: shapes/*.ttl and registry.json
    // already disagree about which namespace `oq:` is, and every other id lookup in
    // this runner is local-name based for the same reason.
    if (localName(q.predicate.value) === 'checkId' && q.object.termType === 'Literal') {
      annotated.set(q.subject.value, q.object.value);
    }
  }

  /** The check id a shape node reports as, following annotations and `sh:property` upwards. */
  const resolve = (node: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const local = localName(node);
    if (registry.checksById.has(local)) return local;
    const annotation = annotated.get(node);
    if (annotation && registry.checksById.has(annotation)) return annotation;
    const parent = parentOf.get(node);
    return parent ? resolve(parent, seen) : undefined;
  };

  const skolemFor = new Map<string, string>();
  const checkIdByShapeIri = new Map<string, string>();
  for (const blank of parentOf.keys()) {
    const checkId = resolve(blank);
    if (!checkId) continue;
    const iri = `${SHAPE_SKOLEM_BASE}${checkId}/property-${skolemFor.size + 1}`;
    skolemFor.set(blank, iri);
    checkIdByShapeIri.set(iri, checkId);
  }
  // A *named* shape can carry its id in an annotation rather than in its own IRI.
  for (const [node, id] of annotated) {
    if (registry.checksById.has(id) && !registry.checksById.has(localName(node))) {
      checkIdByShapeIri.set(node, id);
    }
  }
  if (skolemFor.size === 0) return { text: shapesText, checkIdByShapeIri };

  const rename = <T extends Quad['subject'] | Quad['object']>(term: T): T =>
    term.termType === 'BlankNode' && skolemFor.has(term.value)
      ? (DataFactory.namedNode(skolemFor.get(term.value) as string) as unknown as T)
      : term;
  const renamed = quads.map((q) => DataFactory.quad(rename(q.subject), q.predicate, rename(q.object), q.graph));

  // Handed back as N-Triples for the same reason the data graph is: no prefix table
  // to keep in step, and `fromTurtle` reads it, N-Triples being a Turtle subset.
  const writer = new Writer({ format: 'N-Triples' });
  writer.addQuads(renamed);
  let text = '';
  let failure: Error | undefined;
  writer.end((err, result) => {
    if (err) failure = err;
    else text = result;
  });
  if (failure) throw failure;
  return { text, checkIdByShapeIri };
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
