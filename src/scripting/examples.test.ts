import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import * as dsl from './dsl';
import { parseRdf, serializeRdf } from '../rdf/serialization';

const examples = path.resolve(__dirname, '../../examples/scripting');
const scripts = fs.readdirSync(examples).filter((f) => f.endsWith('.ontology.ts'));

/**
 * Runs an example as Run Ontology Script does -- compiled with `ontology-suite/dsl` left to the
 * runner -- except that the DSL is this one, so build() here sees what the script declared.
 */
async function run(script: string): Promise<{ turtle: string; quads: ReturnType<typeof dsl.build>['quads'] }> {
  const source = fs.readFileSync(path.join(examples, script), 'utf8');
  const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  const require = (id: string) => {
    if (id !== 'ontology-suite/dsl') throw new Error(`${script} requires ${id}; an example should need nothing but the DSL.`);
    return dsl;
  };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  const { quads, prefixes } = dsl.build();
  return { turtle: await serializeRdf(quads, 'turtle', prefixes), quads };
}

describe('the example scripts', () => {
  it('include the zoo example, which uses the whole DSL', () => {
    expect(scripts).toContain('zoo.ontology.ts');
  });

  it.each(scripts)('%s runs, and its Turtle reads back whole', async (script) => {
    const { turtle, quads } = await run(script);
    expect(quads.length).toBeGreaterThan(0);
    const reread = await parseRdf(turtle, 'turtle');
    expect(reread.errors).toEqual([]);
    expect(reread.quads).toHaveLength(quads.length);
  });

  it('zoo.ontology.ts writes its header first, and each kind of statement the DSL has', async () => {
    const { quads } = await run('zoo.ontology.ts');
    const has = (predicate: string, object?: string) => quads.some((q) => q.predicate.value.endsWith(predicate) && (object === undefined || q.object.value.endsWith(object)));
    expect([quads[0].subject.value, quads[0].object.value]).toEqual(['http://example.org/zoo', 'http://www.w3.org/2002/07/owl#Ontology']);
    expect(has('#type', '#NamedIndividual')).toBe(true);
    expect(has('#type', '#FunctionalProperty')).toBe(true);
    expect(has('#type', '#TransitiveProperty')).toBe(true);
    expect(has('#inverseOf')).toBe(true);
    expect(has('#propertyChainAxiom')).toBe(true);
    expect(has('#withRestrictions')).toBe(true);
    expect(has('#differentFrom')).toBe(true);
    expect(has('#disjointWith')).toBe(true);
    expect(has('#unionOf')).toBe(true);
    expect(has('#allValuesFrom')).toBe(true);
  });
});
