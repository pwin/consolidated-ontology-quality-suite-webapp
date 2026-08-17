import { describe, expect, it } from 'vitest';
import { shrink } from './vocab';

const DEMO = 'http://example.org/demo#';

describe('shrink', () => {
  it('prefers a named prefix over the empty one, whichever was declared first', () => {
    // The Outline showed ":Thing" or "ex:Thing" purely on @prefix line order.
    // "ex:Thing" says which vocabulary the term is from, so it wins either way.
    expect(shrink(`${DEMO}Thing`, { '': DEMO, ex: DEMO })).toBe('ex:Thing');
    expect(shrink(`${DEMO}Thing`, { ex: DEMO, '': DEMO })).toBe('ex:Thing');
  });

  it('still uses the empty prefix when it is the only binding', () => {
    expect(shrink(`${DEMO}Thing`, { '': DEMO })).toBe(':Thing');
  });

  it('prefers the longest matching namespace, not the first declared', () => {
    const prefixes = { ex: 'http://ex.org/', sub: 'http://ex.org/sub/' };
    expect(shrink('http://ex.org/sub/Thing', prefixes)).toBe('sub:Thing');
    expect(shrink('http://ex.org/Thing', prefixes)).toBe('ex:Thing');
  });

  it('returns the IRI unchanged when no prefix covers it', () => {
    expect(shrink('http://other.org/Thing', { ex: DEMO })).toBe('http://other.org/Thing');
  });

  it('does not shrink an IRI that is exactly a namespace, leaving an empty local name', () => {
    expect(shrink(DEMO, { ex: DEMO })).toBe(DEMO);
  });

  it('ignores a prefix bound to an empty namespace', () => {
    expect(shrink(`${DEMO}Thing`, { bad: '', ex: DEMO })).toBe('ex:Thing');
  });
});
