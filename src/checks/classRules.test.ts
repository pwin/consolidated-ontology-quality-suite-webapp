import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import { evaluateClassRules, ClassRulesConfig } from './classRules';

const { namedNode, literal, quad } = DataFactory;
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

describe('evaluateClassRules', () => {
  it('flags a subject missing a required predicate, and does not flag one that has it', () => {
    const quads = [
      quad(namedNode('http://ex/Dog'), namedNode(RDF_TYPE), namedNode(OWL_CLASS)),
      quad(namedNode('http://ex/Dog'), namedNode(RDFS_LABEL), literal('Dog', 'en')),
      quad(namedNode('http://ex/Cat'), namedNode(RDF_TYPE), namedNode(OWL_CLASS)),
    ];
    const config: ClassRulesConfig = { rules: [{ appliesTo: 'owl:Class', requires: ['rdfs:label'] }] };
    const rows = evaluateClassRules(quads, config, {});

    expect(rows).toHaveLength(1);
    expect(rows[0].checkId).toBe('PRJ-REQUIRED');
    expect(rows[0].focusNode).toBe('http://ex/Cat');
    expect(rows[0].path).toBe(RDFS_LABEL);
  });

  it('produces one finding per missing predicate when several are required', () => {
    const quads = [quad(namedNode('http://ex/Cat'), namedNode(RDF_TYPE), namedNode(OWL_CLASS))];
    const config: ClassRulesConfig = { rules: [{ appliesTo: 'owl:Class', requires: ['rdfs:label', 'rdfs:comment'] }] };
    const rows = evaluateClassRules(quads, config, {});
    expect(rows.map((r) => r.path).sort()).toEqual([RDFS_COMMENT, RDFS_LABEL].sort());
  });

  it('resolves CURIEs against the document prefixes when not covered by well-known prefixes', () => {
    const quads = [quad(namedNode('http://ex/Widget'), namedNode(RDF_TYPE), namedNode('http://ex/vocab#Product'))];
    const config: ClassRulesConfig = { rules: [{ appliesTo: 'ex:Product', requires: ['rdfs:label'] }] };
    const rows = evaluateClassRules(quads, config, { ex: 'http://ex/vocab#' });
    expect(rows).toHaveLength(1);
    expect(rows[0].focusNode).toBe('http://ex/Widget');
  });

  it('accepts a full IRI directly in appliesTo/requires without needing prefix resolution', () => {
    const quads = [quad(namedNode('http://ex/Cat'), namedNode(RDF_TYPE), namedNode(OWL_CLASS))];
    const config: ClassRulesConfig = { rules: [{ appliesTo: OWL_CLASS, requires: [RDFS_LABEL] }] };
    const rows = evaluateClassRules(quads, config, {});
    expect(rows).toHaveLength(1);
  });

  it('returns no findings when there are no rules configured', () => {
    const quads = [quad(namedNode('http://ex/Cat'), namedNode(RDF_TYPE), namedNode(OWL_CLASS))];
    expect(evaluateClassRules(quads, { rules: [] }, {})).toEqual([]);
  });

  it('does not flag a subject whose rdf:type does not match any rule', () => {
    const quads = [quad(namedNode('http://ex/hasName'), namedNode(RDF_TYPE), namedNode('http://www.w3.org/2002/07/owl#DatatypeProperty'))];
    const config: ClassRulesConfig = { rules: [{ appliesTo: 'owl:Class', requires: ['rdfs:label'] }] };
    expect(evaluateClassRules(quads, config, {})).toEqual([]);
  });
});
