import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from './parseDocument';
import { computeMetrics } from './metrics';

describe('computeMetrics against examples/ontology/domain.ttl', () => {
  const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
  const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));
  const metrics = computeMetrics(doc.quads);

  it('counts classes, object properties, and datatype properties correctly', () => {
    // Mammal, Dog, Cat, Puppy
    expect(metrics.classCount).toBe(4);
    // hasOwner, hasPrimaryOwner
    expect(metrics.objectPropertyCount).toBe(2);
    // hasBirthDate, hasName
    expect(metrics.datatypePropertyCount).toBe(2);
  });

  it('computes max class-hierarchy depth (Mammal -> Dog -> Puppy = depth 2)', () => {
    expect(metrics.maxDepth).toBe(2);
  });

  it('counts subClassOf edges (Dog, Cat, Puppy each have one)', () => {
    expect(metrics.subClassOfEdgeCount).toBe(3);
  });
});
