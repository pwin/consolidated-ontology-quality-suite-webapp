/**
 * The Manchester OWL Syntax class-expression grammar is small and
 * well-specified on its own (see the W3C "OWL 2 Manchester Syntax" note) --
 * unlike the OWL API's `ManchesterOWLSyntaxParserImpl`, which is large
 * mainly because of the surrounding OWLOntology/entity-checker/
 * short-form-provider machinery it's bound to (see the ManchesterSyntaxTool
 * investigation), not because the expression grammar itself is big. This
 * hand-rolls just the expression sub-grammar:
 *
 *   description  ::= conjunction ('or' conjunction)*
 *   conjunction  ::= primary ('and' primary)*
 *   primary      ::= 'not'? (restriction | atomic)
 *   restriction  ::= propertyRef 'some' primary
 *                  | propertyRef 'only' primary
 *                  | propertyRef 'value' (individualRef | literal)
 *                  | propertyRef 'Self'
 *                  | propertyRef ('min'|'max'|'exactly') integer [primary]
 *   atomic       ::= classRef | '{' individualRef (',' individualRef)* '}' | '(' description ')'
 *
 * classExpression.ts translates the result to and from RDF. This module has no
 * imports, so that the TypeScript server plugin (scripting/tsPlugin.ts) can
 * check a script's Manchester text without loading n3 into the editor.
 */

export type ClassExpr =
  | { kind: 'class'; iri: string }
  | { kind: 'and' | 'or'; operands: ClassExpr[] }
  | { kind: 'not'; operand: ClassExpr }
  | { kind: 'oneOf'; individuals: string[] }
  | {
      kind: 'restriction';
      property: string;
      type: 'some' | 'only' | 'value' | 'self' | 'min' | 'max' | 'exactly';
      filler?: ClassExpr;
      individual?: string;
      literalValue?: { value: string; datatype?: string; language?: string };
      cardinality?: number;
    };

/** How mapClassExprNames replaces each kind of name in an expression. */
export interface ClassExprNameMap {
  /** A class name may become a whole class expression. */
  class(name: string): ClassExpr;
  property(name: string): string;
  individual(name: string): string;
  /** A typed literal's datatype. */
  datatype(name: string): string;
}

/**
 * `expr` with every name replaced as `map` says. The parsers leave names as they were written;
 * a caller resolves them with this. Within a restriction the property is mapped before the
 * filler, so an error about the property comes first.
 */
export function mapClassExprNames(expr: ClassExpr, map: ClassExprNameMap): ClassExpr {
  const go = (e: ClassExpr): ClassExpr => {
    switch (e.kind) {
      case 'class':
        return map.class(e.iri);
      case 'and':
      case 'or':
        return { kind: e.kind, operands: e.operands.map(go) };
      case 'not':
        return { kind: 'not', operand: go(e.operand) };
      case 'oneOf':
        return { kind: 'oneOf', individuals: e.individuals.map((name) => map.individual(name)) };
      case 'restriction': {
        const mapped: ClassExpr = { ...e, property: map.property(e.property) };
        if (e.filler) mapped.filler = go(e.filler);
        if (e.individual) mapped.individual = map.individual(e.individual);
        if (e.literalValue?.datatype) mapped.literalValue = { ...e.literalValue, datatype: map.datatype(e.literalValue.datatype) };
        return mapped;
      }
    }
  };
  return go(expr);
}

/** A syntax error at `offset` (and `length` characters on) in the text that was parsed. */
export class ClassExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly length: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token = {
  type: 'word' | 'curie' | 'iri' | 'literal' | 'lparen' | 'rparen' | 'lbrace' | 'rbrace' | 'comma' | 'int';
  value: string;
  start: number;
  end: number;
};

const KEYWORDS = new Set(['and', 'or', 'not', 'some', 'only', 'value', 'min', 'max', 'exactly', 'Self']);

/**
 * Lenient by default, as `.omn` files and the Outline have always had it: an unrecognized
 * character is skipped and an unclosed `<` ends the text. `strict` makes both an error.
 */
export function tokenizeExpression(text: string, strict = false): Token[] {
  const tokens: Token[] = [];
  const push = (type: Token['type'], value: string, start: number, end: number) => tokens.push({ type, value, start, end });
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === ',') {
      push(({ '(': 'lparen', ')': 'rparen', '{': 'lbrace', '}': 'rbrace', ',': 'comma' } as const)[ch], ch, i, i + 1);
      i++;
      continue;
    }
    if (ch === '<') {
      const end = text.indexOf('>', i);
      if (end === -1) {
        if (strict) throw new ClassExpressionSyntaxError("An IRI starting with '<' has no closing '>'.", i, text.length - i);
        break;
      }
      push('iri', text.slice(i + 1, end), i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          value += text[j + 1];
          j += 2;
          continue;
        }
        value += text[j];
        j++;
      }
      if (strict && j >= text.length) throw new ClassExpressionSyntaxError('A string has no closing quote.', i, text.length - i);
      j++; // closing quote
      let datatype: string | undefined;
      let language: string | undefined;
      if (text.slice(j, j + 2) === '^^') {
        const m = /^\^\^(\S+)/.exec(text.slice(j));
        if (m) {
          datatype = m[1];
          j += m[0].length;
        }
      } else if (text[j] === '@') {
        const m = /^@([\w-]+)/.exec(text.slice(j));
        if (m) {
          language = m[1];
          j += m[0].length;
        }
      }
      push('literal', JSON.stringify({ value, datatype, language }), i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      push('int', text.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      let j = i;
      while (j < text.length && /[\w-]/.test(text[j])) j++;
      let value = text.slice(i, j);
      i = j;
      // A CURIE's local part may continue after ':' (e.g. ex:hasOwner) -- greedily
      // extend if a ':' immediately follows an identifier with no whitespace.
      if (text[i] === ':') {
        i++;
        let k = i;
        while (k < text.length && /[\w-]/.test(text[k])) k++;
        value = `${value}:${text.slice(i, k)}`;
        i = k;
        push('curie', value, start, i);
        continue;
      }
      push(KEYWORDS.has(value) ? 'word' : 'curie', value, start, i);
      continue;
    }
    if (strict) throw new ClassExpressionSyntaxError(`Unexpected character '${ch}'.`, i, 1);
    // Unrecognized character (e.g. stray punctuation) -- skip defensively rather than throwing.
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

class TokenStream {
  private pos = 0;
  constructor(
    private tokens: Token[],
    readonly strict: boolean,
    private textLength: number,
  ) {}
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }
  expectWord(word: string): boolean {
    const t = this.peek();
    if (t?.type === 'word' && t.value === word) {
      this.next();
      return true;
    }
    return false;
  }
  /** Throws at `token`, or at the end of the text when there is none. */
  fail(message: string, token?: Token): never {
    throw new ClassExpressionSyntaxError(message, token?.start ?? this.textLength, token ? token.end - token.start : 0);
  }
}

/** Lenient: as `.omn` files and the Outline read an expression. Undefined for empty text. */
export function parseClassExpression(text: string): ClassExpr | undefined {
  const stream = new TokenStream(tokenizeExpression(text), false, text.length);
  if (stream.atEnd()) return undefined;
  const expr = parseDescription(stream);
  return expr;
}

/**
 * Strict: every character must belong to one expression, or this throws a
 * ClassExpressionSyntaxError saying where. What the lenient parser skips or
 * ignores -- a stray character, an unclosed bracket, words after a complete
 * expression, a cardinality that isn't a number -- is an error here.
 */
export function parseClassExpressionStrict(text: string): ClassExpr {
  const stream = new TokenStream(tokenizeExpression(text, true), true, text.length);
  if (stream.atEnd()) stream.fail('Expected a class expression.');
  const expr = parseDescription(stream);
  const extra = stream.peek();
  if (extra) stream.fail(`Unexpected '${extra.value}' after a complete class expression.`, extra);
  return expr;
}

function parseDescription(s: TokenStream): ClassExpr {
  const first = parseConjunction(s);
  const operands = [first];
  while (s.expectWord('or')) operands.push(parseConjunction(s));
  return operands.length === 1 ? operands[0] : { kind: 'or', operands };
}

function parseConjunction(s: TokenStream): ClassExpr {
  const first = parsePrimary(s);
  const operands = [first];
  while (s.expectWord('and')) operands.push(parsePrimary(s));
  return operands.length === 1 ? operands[0] : { kind: 'and', operands };
}

function parsePrimary(s: TokenStream): ClassExpr {
  if (s.expectWord('not')) {
    return { kind: 'not', operand: parsePrimary(s) };
  }
  return parseRestrictionOrAtomic(s);
}

function parseRestrictionOrAtomic(s: TokenStream): ClassExpr {
  const t = s.peek();
  if (!t) s.fail('Unexpected end of class expression.');

  if (t.type === 'lparen') {
    s.next();
    const inner = parseDescription(s);
    if (s.peek()?.type === 'rparen') s.next();
    else if (s.strict) s.fail("Expected ')'.", s.peek());
    return inner;
  }
  if (t.type === 'lbrace') {
    s.next();
    const individuals: string[] = [];
    if (s.strict) {
      for (;;) {
        const item = s.next();
        if (item?.type !== 'curie' && item?.type !== 'iri') s.fail("Expected an individual in '{ ... }'.", item);
        individuals.push(item.value);
        const sep = s.next();
        if (sep?.type === 'rbrace') break;
        if (sep?.type !== 'comma') s.fail("Expected ',' or '}'.", sep);
      }
      return { kind: 'oneOf', individuals };
    }
    while (s.peek() && s.peek()!.type !== 'rbrace') {
      const item = s.next()!;
      if (item.type === 'curie' || item.type === 'iri') individuals.push(item.value);
      if (s.peek()?.type === 'comma') s.next();
    }
    if (s.peek()?.type === 'rbrace') s.next();
    return { kind: 'oneOf', individuals };
  }

  // Either a bare class/individual reference, or the start of a property restriction
  // (`propertyRef some|only|value|Self|min|max|exactly ...`) -- one token of lookahead
  // after the reference tells them apart.
  if (t.type === 'curie' || t.type === 'iri') {
    s.next();
    const propertyRef = t.value;
    const next = s.peek();
    if (next?.type === 'word' && ['some', 'only', 'value', 'Self', 'min', 'max', 'exactly'].includes(next.value)) {
      s.next();
      return parseRestrictionTail(s, propertyRef, next.value);
    }
    return { kind: 'class', iri: propertyRef };
  }

  s.fail(`Unexpected token in class expression: ${JSON.stringify({ type: t.type, value: t.value })}`, t);
}

function parseRestrictionTail(s: TokenStream, propertyRef: string, restrictionWord: string): ClassExpr {
  if (restrictionWord === 'Self') return { kind: 'restriction', property: propertyRef, type: 'self' };

  if (restrictionWord === 'value') {
    const t = s.next();
    if (!t) s.fail("Expected a value after 'value'.");
    if (t.type === 'literal') {
      const parsed = JSON.parse(t.value) as { value: string; datatype?: string; language?: string };
      return { kind: 'restriction', property: propertyRef, type: 'value', literalValue: parsed };
    }
    if (s.strict && t.type !== 'curie' && t.type !== 'iri') s.fail("Expected an individual or a literal after 'value'.", t);
    return { kind: 'restriction', property: propertyRef, type: 'value', individual: t.value };
  }

  if (restrictionWord === 'min' || restrictionWord === 'max' || restrictionWord === 'exactly') {
    const numTok = s.next();
    if (s.strict && numTok?.type !== 'int') s.fail(`Expected a whole number after '${restrictionWord}'.`, numTok);
    const cardinality = numTok ? Number(numTok.value) : 0;
    // An optional filler class expression may follow a cardinality restriction
    // (qualified cardinality); if what follows can't start a primary, it's unqualified.
    const next = s.peek();
    const canStartPrimary = next && (next.type === 'curie' || next.type === 'iri' || next.type === 'lparen' || next.type === 'lbrace' || (next.type === 'word' && next.value === 'not'));
    const filler = canStartPrimary ? parsePrimary(s) : undefined;
    return { kind: 'restriction', property: propertyRef, type: restrictionWord as 'min' | 'max' | 'exactly', cardinality, filler };
  }

  // 'some' | 'only'
  const filler = parsePrimary(s);
  return { kind: 'restriction', property: propertyRef, type: restrictionWord as 'some' | 'only', filler };
}
