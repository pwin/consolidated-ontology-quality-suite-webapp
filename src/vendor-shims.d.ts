// Minimal ambient declarations for dependencies that ship no TypeScript
// types. Deliberately loose (`any`-shaped) -- these are internal
// implementation details wrapped by our own typed ResultRow boundary in
// checks/reasoningRunner.ts, not part of the extension's public surface.
//
// `shacl-engine`, `@rdfjs/data-model` and `@zazuko/env-node` were declared here
// until v0.10.0, when SHACL validation moved to the vendored `shacl-wasm`
// build (resources/shacl-wasm/). That package ships its own .d.ts, and
// checks/shaclRunner.ts declares the narrow slice of it that it uses, so none
// of the three is a dependency any more.

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
