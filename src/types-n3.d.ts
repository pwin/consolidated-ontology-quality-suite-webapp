// n3@2.x ships no TypeScript types, and the only `@types/n3` package on
// npm (1.26.1) targets the old v1 API surface -- rather than risk a
// version-mismatched types package silently misdescribing v2's actual
// API, this is a minimal, hand-verified ambient declaration covering only
// what this extension actually calls (Parser.parse's synchronous
// array-return form, Writer.end's synchronous callback form, and the
// RDF/JS term/quad shapes), confirmed against the installed n3@2.1.1 at
// c:\repos\consolidated_ontology_suite_webapp\node_modules\n3.

declare module 'n3' {
  export type TermType = 'NamedNode' | 'BlankNode' | 'Literal' | 'Variable' | 'DefaultGraph';

  export interface Term {
    termType: TermType;
    value: string;
    equals(other: Term | null | undefined): boolean;
  }

  export interface NamedNode extends Term {
    termType: 'NamedNode';
  }

  export interface BlankNode extends Term {
    termType: 'BlankNode';
  }

  export interface Literal extends Term {
    termType: 'Literal';
    language: string;
    datatype: NamedNode;
  }

  export interface Variable extends Term {
    termType: 'Variable';
  }

  export interface DefaultGraph extends Term {
    termType: 'DefaultGraph';
  }

  export type Quad_Subject = NamedNode | BlankNode | Variable;
  export type Quad_Predicate = NamedNode | Variable;
  export type Quad_Object = NamedNode | BlankNode | Literal | Variable;
  export type Quad_Graph = NamedNode | BlankNode | DefaultGraph | Variable;

  export interface Quad {
    subject: Quad_Subject;
    predicate: Quad_Predicate;
    object: Quad_Object;
    graph: Quad_Graph;
    equals(other: Quad | null | undefined): boolean;
  }

  export interface ParserOptions {
    format?: string;
    baseIRI?: string;
    blankNodePrefix?: string;
  }

  type PrefixCallback = (prefix: string, iri: NamedNode) => void;

  export class Parser {
    constructor(options?: ParserOptions);
    /** Synchronous form (no callback): returns the full array of parsed quads, throws on error. */
    parse(input: string, quadCallback?: undefined, prefixCallback?: PrefixCallback): Quad[];
    /** Streaming form: quadCallback is invoked per quad, with `null` signalling EOF. */
    parse(input: string, quadCallback: (error: Error | null, quad: Quad | null) => void, prefixCallback?: PrefixCallback): void;
  }

  export interface WriterOptions {
    format?: string;
    prefixes?: Record<string, string>;
  }

  export class Writer {
    constructor(options?: WriterOptions);
    addQuad(quad: Quad): void;
    addQuads(quads: Quad[]): void;
    /** n3's Writer invokes this callback synchronously before `.end()` returns. */
    end(callback: (error: Error | null, result: string) => void): void;
  }

  export class Store {
    constructor(quads?: Quad[]);
    addQuad(quad: Quad): void;
    addQuads(quads: Quad[]): void;
    removeQuads(quads: Quad[]): void;
    getQuads(subject: Term | null, predicate: Term | null, object: Term | null, graph: Term | null): Quad[];
    readonly size: number;
  }

  export const DataFactory: {
    namedNode(value: string): NamedNode;
    blankNode(value?: string): BlankNode;
    literal(value: string, languageOrDatatype?: string | NamedNode): Literal;
    variable(value: string): Variable;
    defaultGraph(): DefaultGraph;
    quad(subject: Quad_Subject, predicate: Quad_Predicate, object: Quad_Object, graph?: Quad_Graph): Quad;
  };
}
