/* tslint:disable */
/* eslint-disable */

/**
 * The outcome of one validation run.
 */
export class Report {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The full SHACL validation report as a Turtle graph -- what a SHACL
     * processor is formally meant to return, for querying or diffing.
     */
    toTurtle(): string;
    /**
     * True when nothing in the report has a conformance-blocking severity
     * (`sh:Violation`).
     */
    readonly conforms: boolean;
    /**
     * Number of results, blocking or not.
     */
    readonly length: number;
    /**
     * The results as an array of plain objects.
     */
    readonly results: any;
}

/**
 * A compiled shapes graph, ready to validate data graphs against.
 *
 * `store` is the term store as it stood once the shapes were compiled, and is
 * never mutated afterwards: each validation run clones it and grows its own
 * copy. That is the pattern `TermStore`'s own documentation describes, and
 * following it is what makes reuse actually pay.
 *
 * Parsing each data graph into one shared store instead — which this did at
 * first — leaves every earlier run's terms behind, so the store grows without
 * bound and the advertised path (compile once, validate many) is precisely the
 * one that degrades. Measured on 100k instances / 400k triples: 23.7s sharing
 * one store against 6.5s cloning per run, and the gap widens with every run.
 */
export class Validator {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Compiles a shapes graph in any format the engine can read: `turtle`,
     * `ntriples`, `nquads`, `trig`, `rdfxml`, `jsonld`.
     */
    static fromText(text: string, format: string, base?: string | null): Validator;
    /**
     * Compiles a shapes graph given as Turtle.
     */
    static fromTurtle(text: string, base?: string | null): Validator;
    /**
     * Validates a data graph in any supported format.
     *
     * `inference` is `"none"` (default) or `"rdfs"`; the latter validates
     * against the RDFS closure of the data, so a finding can depend on an
     * entailed `rdf:type` rather than only an asserted one.
     */
    validateText(text: string, format: string, base?: string | null, inference?: string | null): Report;
    /**
     * Validates a data graph given as Turtle.
     */
    validateTurtle(text: string, base?: string | null, inference?: string | null): Report;
    /**
     * How many shapes were compiled. Zero usually means the shapes graph
     * parsed but declared nothing the engine recognises as a shape.
     */
    readonly shapeCount: number;
}

/**
 * Improves panic reporting from a bare `RuntimeError: unreachable` to the real
 * Rust panic message and stack on `console.error`. Runs automatically on module
 * load; the alternative is a genuinely undebuggable failure mode.
 */
export function start(): void;

/**
 * One-shot validation, for a caller with a single data graph that gains
 * nothing from holding a compiled [`Validator`].
 */
export function validateTurtle(shapes: string, data: string, base?: string | null): Report;
