import { describe, expect, it } from 'vitest';
import { ClassExpressionSyntaxError, mapClassExprNames, parseClassExpression, parseClassExpressionStrict } from './classExpressionParser';

function syntaxError(text: string): { message: string; offset: number; length: number } {
  try {
    parseClassExpressionStrict(text);
  } catch (err) {
    if (err instanceof ClassExpressionSyntaxError) return { message: err.message, offset: err.offset, length: err.length };
    throw err;
  }
  throw new Error(`parsed without an error: ${text}`);
}

describe('parseClassExpressionStrict', () => {
  it.each([
    'ex:Dog',
    'ex:Dog and ex:OwnedDog or ex:Cat',
    'not ex:Dog',
    'ex:hasOwner some (ex:Person or ex:Company)',
    'ex:hasOwner value ex:alice',
    'ex:status value "endangered"@en',
    'ex:hasOwner Self',
    'ex:hasOwner exactly 1 ex:Person',
    'ex:hasOwner max 2',
    '{ex:alice, <http://example.org/demo#bob>}',
  ])('reads a well-formed expression as the lenient parser does: %s', (text) => {
    expect(parseClassExpressionStrict(text)).toEqual(parseClassExpression(text));
  });

  it.each([
    ['', 'Expected a class expression.', 0, 0],
    ['ex:p some', 'Unexpected end of class expression.', 9, 0],
    ['ex:p some ex:B extra', "Unexpected 'extra' after a complete class expression.", 15, 5],
    ['(ex:A or ex:B', "Expected ')'.", 13, 0],
    ['ex:p min ex:C', "Expected a whole number after 'min'.", 9, 4],
    ['ex:A & ex:B', "Unexpected character '&'.", 5, 1],
    ['{ex:a ex:b}', "Expected ',' or '}'.", 6, 4],
    ['{ex:a, }', "Expected an individual in '{ ... }'.", 7, 1],
    ['ex:p value (ex:a)', "Expected an individual or a literal after 'value'.", 11, 1],
    ['<http://example.org/x', "An IRI starting with '<' has no closing '>'.", 0, 21],
    ['ex:p value "open', 'A string has no closing quote.', 11, 5],
  ])('rejects %j: %s', (text, message, offset, length) => {
    expect(syntaxError(text)).toEqual({ message, offset, length });
  });
});

describe('mapClassExprNames', () => {
  it('maps every name by its kind, wherever it is in the expression', () => {
    const expr = parseClassExpressionStrict('A and not (p some {i, j}) and q value k and r value "5"^^xsd:int and s min 2 (B or C)');
    const mapped = mapClassExprNames(expr, {
      class: (n) => ({ kind: 'class', iri: `class:${n}` }),
      property: (n) => `property:${n}`,
      individual: (n) => `individual:${n}`,
      datatype: (n) => `datatype:${n}`,
    });
    expect(mapped).toEqual(
      parseClassExpressionStrict(
        '<class:A> and not (<property:p> some {<individual:i>, <individual:j>}) and <property:q> value <individual:k> and <property:r> value "5"^^datatype:xsd:int and <property:s> min 2 (<class:B> or <class:C>)',
      ),
    );
  });

  it('lets a class name become a whole expression', () => {
    const inner = parseClassExpressionStrict('p some B');
    expect(mapClassExprNames(parseClassExpressionStrict('A or X'), { class: (n) => (n === 'X' ? inner : { kind: 'class', iri: n }), property: (n) => n, individual: (n) => n, datatype: (n) => n })).toEqual({
      kind: 'or',
      operands: [{ kind: 'class', iri: 'A' }, inner],
    });
  });
});

describe('parseClassExpression stays lenient, as .omn files and the Outline rely on', () => {
  it('ignores words after a complete expression, and skips characters it does not know', () => {
    expect(parseClassExpression('ex:A ex:B')).toEqual({ kind: 'class', iri: 'ex:A' });
    expect(parseClassExpression('ex:A & ex:B')).toEqual({ kind: 'class', iri: 'ex:A' });
    expect(parseClassExpression('(ex:A or ex:B')).toEqual({ kind: 'or', operands: [{ kind: 'class', iri: 'ex:A' }, { kind: 'class', iri: 'ex:B' }] });
  });
});
