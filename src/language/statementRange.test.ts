import { describe, expect, it } from 'vitest';
import { findStatementLineRange, stripStringLiteralsAndIris } from './statementRange';

describe('findStatementLineRange', () => {
  it('finds a single-line statement', () => {
    const text = 'ex:Dog a owl:Class .\nex:Cat a owl:Class .\n';
    expect(findStatementLineRange(text, 0)).toEqual({ startLine: 0, endLine: 0, endCol: 20 });
  });

  it('spans a multi-line statement with a `;`-separated predicate list', () => {
    const text = ['ex:Dog', '  a owl:Class ;', '  rdfs:label "Dog" ;', '  .', 'ex:Cat a owl:Class .'].join('\n');
    const range = findStatementLineRange(text, 0);
    expect(range.endLine).toBe(3);
  });

  it('does not stop at a `.` inside a blank-node restriction', () => {
    const text = ['ex:OwnedAnimal', '  a owl:Class ;', '  rdfs:subClassOf [', '    a owl:Restriction ;', '    owl:onProperty ex:hasOwner ;', '  ] ;', '  .', 'ex:Next a owl:Class .'].join('\n');
    const range = findStatementLineRange(text, 0);
    expect(range.endLine).toBe(6);
  });

  it('does not stop at a `.` inside a string literal', () => {
    const text = 'ex:Dog rdfs:comment "e.g. a domestic dog." .\nex:Cat a owl:Class .';
    const range = findStatementLineRange(text, 0);
    expect(range.endLine).toBe(0);
  });

  it('does not treat a decimal point as a statement terminator', () => {
    const text = 'ex:x ex:weight 3.5 .\nex:y a owl:Class .';
    const range = findStatementLineRange(text, 0);
    expect(range.endLine).toBe(0);
    expect(range.endCol).toBe(20); // the real terminating `.` at the end, not the one inside "3.5"
  });

  it('does not stop at a `.` inside an IRIREF domain name (e.g. <http://example.org/clinic>)', () => {
    const text = ['<http://example.org/clinic>', '  a owl:Ontology ;', '  owl:imports <http://example.org/clinic/core> ;', '  .', 'ex:Next a owl:Class .'].join('\n');
    const range = findStatementLineRange(text, 0);
    expect(range.endLine).toBe(3);
  });

  it('falls back to the declaration line alone if no terminator is found within the window', () => {
    const text = 'ex:Dog a owl:Class ;\n  rdfs:label "Dog"'; // deliberately unterminated
    const range = findStatementLineRange(text, 0);
    expect(range.endLine).toBe(0);
  });
});

describe('stripStringLiteralsAndIris', () => {
  it('replaces double-quoted and single-quoted strings with same-length spaces', () => {
    expect(stripStringLiteralsAndIris('a "b.c" d')).toBe('a       d');
    expect(stripStringLiteralsAndIris("a 'b.c' d")).toBe('a       d');
  });

  it('replaces an angle-bracketed IRIREF (including any `.` inside it, e.g. a domain name) with spaces', () => {
    expect(stripStringLiteralsAndIris('<http://example.org/clinic>')).toBe(' '.repeat('<http://example.org/clinic>'.length));
  });

  it('leaves non-string, non-IRI content untouched', () => {
    expect(stripStringLiteralsAndIris('ex:Dog a owl:Class .')).toBe('ex:Dog a owl:Class .');
  });
});
