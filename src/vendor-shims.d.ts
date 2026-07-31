// Minimal ambient declarations for dependencies that ship no TypeScript
// types. Deliberately loose (`any`-shaped) -- these are internal
// implementation details wrapped by our own typed ResultRow boundary in
// checks/shaclRunner.ts and checks/reasoningRunner.ts, not part of the
// extension's public surface.

declare module 'shacl-engine' {
  export interface ShaclTerm {
    value: string;
    termType: string;
  }
  export interface ShaclValidationResult {
    focusNode?: ShaclTerm;
    path?: ShaclTerm;
    value?: ShaclTerm;
    severity?: ShaclTerm;
    message: ShaclTerm[] | ShaclTerm | undefined;
    shape?: { ptr?: { value?: string } };
  }
  export interface ShaclReport {
    conforms: boolean;
    results: ShaclValidationResult[];
  }
  export interface ValidatorOptions {
    factory: unknown;
    targetResolvers?: unknown;
    validations?: unknown;
    coverage?: boolean;
    debug?: boolean;
    details?: boolean;
    trace?: boolean;
  }
  export class Validator {
    constructor(shapes: unknown, options: ValidatorOptions);
    validate(data: { dataset: unknown; terms?: Iterable<unknown> }): Promise<ShaclReport>;
  }
}

declare module 'shacl-engine/sparql.js' {
  export const targetResolvers: unknown;
  export const validations: unknown;
}

declare module '@rdfjs/data-model' {
  const factory: unknown;
  export default factory;
}

declare module '@zazuko/env-node' {
  interface ZazukoEnv {
    dataset(quads?: Iterable<unknown>): { add(quad: unknown): void; import?(stream: unknown): Promise<unknown> };
    [key: string]: unknown;
  }
  const rdf: ZazukoEnv;
  export default rdf;
}

declare module 'eyereasoner' {
  export function n3reasoner(
    data: string | unknown[],
    query?: string | unknown[],
    options?: {
      output?: 'derivations' | 'deductive_closure' | 'deductive_closure_plus_rules' | 'grounded_deductive_closure_plus_rules' | 'none';
      outputType?: 'string' | 'quads';
    },
  ): Promise<string | unknown[]>;
}
