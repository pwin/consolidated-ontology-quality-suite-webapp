import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { organizeDocument, removeUnusedPrefixDeclarations, sortBlocks, splitDocumentIntoBlocks } from './documentSort';

const SIMPLE = `@prefix ex: <http://example.org/pets#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

# File header, separated by a blank line -- should float to the top as a preamble,
# not move with whichever block happens to sort first.

ex:Zebra a owl:Class ;
  rdfs:label "Zebra" .

# Directly attached comment -- should move with ex:Ant.
ex:Ant a owl:Class ;
  rdfs:label "Ant" .

ex:hasOwner a owl:ObjectProperty .
`;

describe('splitDocumentIntoBlocks', () => {
  it('separates prefixes, a blank-line-detached preamble, and per-statement blocks', () => {
    const { prefixes } = parseTurtle('file:///t.ttl', SIMPLE);
    const split = splitDocumentIntoBlocks(SIMPLE, prefixes);

    expect(split.prefixLines).toHaveLength(3);
    expect(split.preambleComments.join('\n')).toContain('File header');
    expect(split.blocks).toHaveLength(3);
    expect(split.blocks.map((b) => b.subjectIri)).toEqual([
      'http://example.org/pets#Zebra',
      'http://example.org/pets#Ant',
      'http://example.org/pets#hasOwner',
    ]);
  });

  it('attaches a comment with no blank line before it to the following block, not the preamble', () => {
    const { prefixes } = parseTurtle('file:///t.ttl', SIMPLE);
    const split = splitDocumentIntoBlocks(SIMPLE, prefixes);
    const ant = split.blocks.find((b) => b.subjectIri === 'http://example.org/pets#Ant')!;
    expect(ant.attachedLines.join('\n')).toContain('Directly attached comment');
    expect(split.preambleComments.join('\n')).not.toContain('Directly attached');
  });
});

describe('sortBlocks', () => {
  it('sorts alphabetically by local name', () => {
    const { prefixes, quads } = parseTurtle('file:///t.ttl', SIMPLE);
    const split = splitDocumentIntoBlocks(SIMPLE, prefixes);
    const sorted = sortBlocks(split.blocks, 'alphabetical', quads);
    expect(sorted.map((b) => b.subjectIri)).toEqual([
      'http://example.org/pets#Ant',
      'http://example.org/pets#hasOwner',
      'http://example.org/pets#Zebra',
    ]);
  });

  it('groups by kind (class before objectProperty) before sorting alphabetically within each group', () => {
    const { prefixes, quads } = parseTurtle('file:///t.ttl', SIMPLE);
    const split = splitDocumentIntoBlocks(SIMPLE, prefixes);
    const sorted = sortBlocks(split.blocks, 'byType', quads);
    expect(sorted.map((b) => b.subjectIri)).toEqual([
      'http://example.org/pets#Ant', // class
      'http://example.org/pets#Zebra', // class
      'http://example.org/pets#hasOwner', // objectProperty
    ]);
  });

  it('floats a block whose subject is declared owl:Ontology to the front under byType', () => {
    const text = `@prefix ex: <http://example.org/pets#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

ex:Zebra a owl:Class .

<http://example.org/pets> a owl:Ontology .
`;
    const { prefixes, quads } = parseTurtle('file:///t.ttl', text);
    const split = splitDocumentIntoBlocks(text, prefixes);
    const sorted = sortBlocks(split.blocks, 'byType', quads);
    expect(sorted[0].subjectIri).toBe('http://example.org/pets');
  });
});

describe('removeUnusedPrefixDeclarations', () => {
  it('drops a prefix never referenced in the body, keeps ones that are used', () => {
    const prefixLines = ['@prefix ex: <http://example.org/pets#> .', '@prefix unused: <http://example.org/unused#> .'];
    const body = 'ex:Dog a owl:Class .';
    expect(removeUnusedPrefixDeclarations(prefixLines, body)).toEqual(['@prefix ex: <http://example.org/pets#> .']);
  });

  it('always keeps @base declarations', () => {
    const prefixLines = ['@base <http://example.org/> .'];
    expect(removeUnusedPrefixDeclarations(prefixLines, '')).toEqual(prefixLines);
  });
});

describe('organizeDocument against a real fixture', () => {
  it('preserves every meaningful line of clinic.ttl through a byType sort + unused-prefix removal round trip', () => {
    const clinicPath = path.resolve(__dirname, '../../examples/tutorial/clinic.ttl');
    const text = fs.readFileSync(clinicPath, 'utf8');
    const { prefixes, quads } = parseTurtle(clinicPath, text);

    const organized = organizeDocument(text, prefixes, quads, { removeUnusedPrefixes: true, sortStrategy: 'byType' });

    // Re-parses to the same quads (order-independent) -- the sort/clean round trip is lossless at the RDF level.
    const before = parseTurtle(clinicPath, text).quads;
    const after = parseTurtle(clinicPath, organized).quads;
    const key = (q: (typeof before)[number]) => `${q.subject.value}|${q.predicate.value}|${q.object.value}`;
    expect(new Set(after.map(key))).toEqual(new Set(before.map(key)));
    expect(after).toHaveLength(before.length);

    // Every real comment survives somewhere in the output (verbatim), just possibly relocated.
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) expect(organized).toContain(line.trim());
    }
  });

  it('is idempotent -- organizing an already-organized document changes nothing further', () => {
    const clinicPath = path.resolve(__dirname, '../../examples/tutorial/clinic.ttl');
    const text = fs.readFileSync(clinicPath, 'utf8');
    const { prefixes, quads } = parseTurtle(clinicPath, text);

    const once = organizeDocument(text, prefixes, quads, { removeUnusedPrefixes: true, sortStrategy: 'byType' });
    const onceParsed = parseTurtle(clinicPath, once);
    const twice = organizeDocument(once, onceParsed.prefixes, onceParsed.quads, { removeUnusedPrefixes: true, sortStrategy: 'byType' });

    expect(twice).toBe(once);
  });
});
