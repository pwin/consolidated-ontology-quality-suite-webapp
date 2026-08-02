import { describe, expect, it } from 'vitest';
import { parseTurtle } from './parseDocument';

describe('parseTurtle', () => {
  it('parses a well-formed document and collects prefixes', () => {
    const doc = parseTurtle(
      'test://doc',
      '@prefix ex: <http://example.org/> .\nex:a ex:b ex:c .\n',
    );
    expect(doc.errors).toEqual([]);
    expect(doc.quads).toHaveLength(1);
    expect(doc.prefixes.ex).toBe('http://example.org/');
  });

  it('reports a line-numbered error but still recovers declared prefixes', () => {
    const doc = parseTurtle(
      'test://doc',
      '@prefix ex: <http://example.org/> .\nex:a ex:b .\nex:bad',
    );
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0].line).toBeGreaterThanOrEqual(0);
    expect(doc.prefixes.ex).toBe('http://example.org/');
  });
});
