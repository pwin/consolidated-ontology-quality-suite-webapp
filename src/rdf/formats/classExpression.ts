import { BlankNode, DataFactory, NamedNode, Quad, Term } from 'n3';
import { expand, shrink, OWL, RDF, XSD } from '../vocab';

const { namedNode, blankNode, literal, quad } = DataFactory;

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
 * translated to/from the standard OWL2-in-RDF blank-node encoding
 * (owl:intersectionOf/unionOf/complementOf/oneOf, owl:Restriction +
 * owl:onProperty + owl:someValuesFrom/allValuesFrom/hasValue/hasSelf/
 * [min|max|qualified]Cardinality [+ owl:onClass/onDataRange]).
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

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token = { type: 'word' | 'curie' | 'iri' | 'literal' | 'lparen' | 'rparen' | 'lbrace' | 'rbrace' | 'comma' | 'int'; value: string };

const KEYWORDS = new Set(['and', 'or', 'not', 'some', 'only', 'value', 'min', 'max', 'exactly', 'Self']);

export function tokenizeExpression(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch });
      i++;
      continue;
    }
    if (ch === '{') {
      tokens.push({ type: 'lbrace', value: ch });
      i++;
      continue;
    }
    if (ch === '}') {
      tokens.push({ type: 'rbrace', value: ch });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch });
      i++;
      continue;
    }
    if (ch === '<') {
      const end = text.indexOf('>', i);
      if (end === -1) break;
      tokens.push({ type: 'iri', value: text.slice(i + 1, end) });
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
      tokens.push({ type: 'literal', value: JSON.stringify({ value, datatype, language }) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      tokens.push({ type: 'int', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
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
        tokens.push({ type: 'curie', value });
        continue;
      }
      tokens.push({ type: KEYWORDS.has(value) ? 'word' : 'curie', value });
      continue;
    }
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
  constructor(private tokens: Token[]) {}
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
}

export function parseClassExpression(text: string): ClassExpr | undefined {
  const stream = new TokenStream(tokenizeExpression(text));
  if (stream.atEnd()) return undefined;
  const expr = parseDescription(stream);
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
  if (!t) throw new Error('Unexpected end of class expression.');

  if (t.type === 'lparen') {
    s.next();
    const inner = parseDescription(s);
    if (s.peek()?.type === 'rparen') s.next();
    return inner;
  }
  if (t.type === 'lbrace') {
    s.next();
    const individuals: string[] = [];
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

  throw new Error(`Unexpected token in class expression: ${JSON.stringify(t)}`);
}

function parseRestrictionTail(s: TokenStream, propertyRef: string, restrictionWord: string): ClassExpr {
  if (restrictionWord === 'Self') return { kind: 'restriction', property: propertyRef, type: 'self' };

  if (restrictionWord === 'value') {
    const t = s.next();
    if (!t) throw new Error("Expected a value after 'value'.");
    if (t.type === 'literal') {
      const parsed = JSON.parse(t.value) as { value: string; datatype?: string; language?: string };
      return { kind: 'restriction', property: propertyRef, type: 'value', literalValue: parsed };
    }
    return { kind: 'restriction', property: propertyRef, type: 'value', individual: t.value };
  }

  if (restrictionWord === 'min' || restrictionWord === 'max' || restrictionWord === 'exactly') {
    const numTok = s.next();
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

// ---------------------------------------------------------------------------
// AST <-> RDF (OWL2 blank-node encoding)
// ---------------------------------------------------------------------------

export function classExprToRdf(expr: ClassExpr, prefixes: Record<string, string>, out: Quad[]): NamedNode | BlankNode {
  const resolve = (ref: string): string => (ref.startsWith('http://') || ref.startsWith('https://') ? ref : expand(ref, prefixes) ?? ref);

  switch (expr.kind) {
    case 'class':
      return namedNode(resolve(expr.iri));
    case 'and':
    case 'or': {
      const bnode = blankNode();
      const listHead = rdfList(
        expr.operands.map((o) => classExprToRdf(o, prefixes, out)),
        out,
      );
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Class`)));
      out.push(quad(bnode, namedNode(expr.kind === 'and' ? `${OWL}intersectionOf` : `${OWL}unionOf`), listHead));
      return bnode;
    }
    case 'not': {
      const bnode = blankNode();
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Class`)));
      out.push(quad(bnode, namedNode(`${OWL}complementOf`), classExprToRdf(expr.operand, prefixes, out)));
      return bnode;
    }
    case 'oneOf': {
      const bnode = blankNode();
      const listHead = rdfList(
        expr.individuals.map((i) => namedNode(resolve(i))),
        out,
      );
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Class`)));
      out.push(quad(bnode, namedNode(`${OWL}oneOf`), listHead));
      return bnode;
    }
    case 'restriction': {
      const bnode = blankNode();
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Restriction`)));
      out.push(quad(bnode, namedNode(`${OWL}onProperty`), namedNode(resolve(expr.property))));
      switch (expr.type) {
        case 'some':
          out.push(quad(bnode, namedNode(`${OWL}someValuesFrom`), classExprToRdf(expr.filler!, prefixes, out)));
          break;
        case 'only':
          out.push(quad(bnode, namedNode(`${OWL}allValuesFrom`), classExprToRdf(expr.filler!, prefixes, out)));
          break;
        case 'self':
          out.push(quad(bnode, namedNode(`${OWL}hasSelf`), literal('true', namedNode(`${XSD}boolean`))));
          break;
        case 'value':
          if (expr.individual) out.push(quad(bnode, namedNode(`${OWL}hasValue`), namedNode(resolve(expr.individual))));
          else if (expr.literalValue) {
            const lv = expr.literalValue;
            out.push(
              quad(
                bnode,
                namedNode(`${OWL}hasValue`),
                lv.language ? literal(lv.value, lv.language) : literal(lv.value, namedNode(lv.datatype ? resolve(lv.datatype) : `${XSD}string`)),
              ),
            );
          }
          break;
        case 'min':
        case 'max':
        case 'exactly': {
          const card = String(expr.cardinality ?? 0);
          const qualified = Boolean(expr.filler);
          const predBase = expr.type === 'min' ? 'minCardinality' : expr.type === 'max' ? 'maxCardinality' : 'cardinality';
          const pred = qualified ? `${OWL}${predBase.replace('Cardinality', 'QualifiedCardinality')}` : `${OWL}${predBase}`;
          out.push(quad(bnode, namedNode(pred), literal(card, namedNode(`${XSD}nonNegativeInteger`))));
          if (qualified) out.push(quad(bnode, namedNode(`${OWL}onClass`), classExprToRdf(expr.filler!, prefixes, out)));
          break;
        }
      }
      return bnode;
    }
  }
}

function rdfList(items: (NamedNode | BlankNode)[], out: Quad[]): NamedNode | BlankNode {
  if (items.length === 0) return namedNode(`${RDF}nil`);
  let tail: NamedNode | BlankNode = namedNode(`${RDF}nil`);
  const nodes = items.map(() => blankNode());
  for (let i = items.length - 1; i >= 0; i--) {
    out.push(quad(nodes[i], namedNode(`${RDF}first`), items[i]));
    out.push(quad(nodes[i], namedNode(`${RDF}rest`), tail));
    tail = nodes[i];
  }
  return tail;
}

/**
 * How deep a blank-node class expression may nest before this gives up.
 *
 * Well past anything an ontology contains -- gist's deepest is single figures --
 * and the point is only to fail as `undefined` rather than as a stack overflow.
 */
const MAX_CLASS_EXPRESSION_DEPTH = 200;

/** Reads an OWL2 blank-node class expression back out of a quad set (the inverse of classExprToRdf). */
export function rdfToClassExpr(term: Term, bySubject: Map<string, Quad[]>): ClassExpr | undefined {
  return readClassExpr(term, bySubject, new Set(), 0);
}

/**
 * `ancestors` holds the blank nodes on the path down to `term`, so a node that is
 * its own ancestor stops here instead of recurring forever.
 *
 * A cyclic class expression is malformed OWL but perfectly well-formed RDF, and it
 * takes two triples: `_:b owl:complementOf _:b`. Before this guard that was a hard
 * `RangeError: Maximum call stack size exceeded` out of the Manchester serializer,
 * so one corrupt file took down whatever asked to render it. Legitimate depth blew
 * the stack too, between 2,000 and 20,000 levels. Same class of bug as the
 * `computeMaxDepth` fix in 0.11.4 and the six walks
 * `consolidated_ontology_suite_python` rewrote onto the heap in its 0.7.0: a graph
 * walk that guards neither cycles nor descent.
 *
 * Path-scoped rather than a single visited set for the whole walk: one blank node
 * legitimately reached down two different branches should render in both, and only
 * a node reached from itself is a cycle.
 */
function readClassExpr(term: Term, bySubject: Map<string, Quad[]>, ancestors: Set<string>, depth: number): ClassExpr | undefined {
  if (term.termType === 'NamedNode') return { kind: 'class', iri: term.value };
  if (term.termType !== 'BlankNode') return undefined;
  if (depth > MAX_CLASS_EXPRESSION_DEPTH || ancestors.has(term.value)) return undefined;

  ancestors.add(term.value);
  try {
    return readClassExprBody(term, bySubject, ancestors, depth);
  } finally {
    ancestors.delete(term.value);
  }
}

function readClassExprBody(term: Term, bySubject: Map<string, Quad[]>, ancestors: Set<string>, depth: number): ClassExpr | undefined {
  const own = bySubject.get(term.value) ?? [];
  const get = (pred: string) => own.find((q) => q.predicate.value === pred)?.object;

  const intersectionOf = get(`${OWL}intersectionOf`);
  if (intersectionOf) return { kind: 'and', operands: readRdfList(intersectionOf, bySubject).map((t) => readClassExpr(t, bySubject, ancestors, depth + 1)!).filter(Boolean) };
  const unionOf = get(`${OWL}unionOf`);
  if (unionOf) return { kind: 'or', operands: readRdfList(unionOf, bySubject).map((t) => readClassExpr(t, bySubject, ancestors, depth + 1)!).filter(Boolean) };
  const complementOf = get(`${OWL}complementOf`);
  if (complementOf) {
    const operand = readClassExpr(complementOf, bySubject, ancestors, depth + 1);
    return operand ? { kind: 'not', operand } : undefined;
  }
  const oneOf = get(`${OWL}oneOf`);
  if (oneOf) return { kind: 'oneOf', individuals: readRdfList(oneOf, bySubject).map((t) => t.value) };

  const onProperty = get(`${OWL}onProperty`);
  if (onProperty) {
    const property = onProperty.value;
    const someValuesFrom = get(`${OWL}someValuesFrom`);
    if (someValuesFrom) return { kind: 'restriction', property, type: 'some', filler: readClassExpr(someValuesFrom, bySubject, ancestors, depth + 1) };
    const allValuesFrom = get(`${OWL}allValuesFrom`);
    if (allValuesFrom) return { kind: 'restriction', property, type: 'only', filler: readClassExpr(allValuesFrom, bySubject, ancestors, depth + 1) };
    const hasValue = get(`${OWL}hasValue`);
    if (hasValue) {
      if (hasValue.termType === 'NamedNode') return { kind: 'restriction', property, type: 'value', individual: hasValue.value };
      const lit = hasValue as import('n3').Literal;
      return { kind: 'restriction', property, type: 'value', literalValue: { value: lit.value, datatype: lit.datatype?.value, language: lit.language || undefined } };
    }
    const hasSelf = get(`${OWL}hasSelf`);
    if (hasSelf) return { kind: 'restriction', property, type: 'self' };
    for (const [predSuffix, kind] of [
      ['minQualifiedCardinality', 'min'],
      ['maxQualifiedCardinality', 'max'],
      ['qualifiedCardinality', 'exactly'],
      ['minCardinality', 'min'],
      ['maxCardinality', 'max'],
      ['cardinality', 'exactly'],
    ] as const) {
      const card = get(`${OWL}${predSuffix}`);
      if (card) {
        const onClass = get(`${OWL}onClass`) ?? get(`${OWL}onDataRange`);
        return {
          kind: 'restriction',
          property,
          type: kind,
          cardinality: Number(card.value),
          filler: onClass ? readClassExpr(onClass, bySubject, ancestors, depth + 1) : undefined,
        };
      }
    }
  }
  return undefined;
}

function readRdfList(head: Term, bySubject: Map<string, Quad[]>): Term[] {
  const items: Term[] = [];
  let current = head;
  const seen = new Set<string>();
  while (current.termType === 'BlankNode' && !seen.has(current.value)) {
    seen.add(current.value);
    const quads = bySubject.get(current.value) ?? [];
    const first = quads.find((q) => q.predicate.value === `${RDF}first`)?.object;
    const rest = quads.find((q) => q.predicate.value === `${RDF}rest`)?.object;
    if (first) items.push(first);
    if (!rest) break;
    current = rest;
  }
  return items;
}

/** Renders a ClassExpr back to Manchester text, parenthesizing only where precedence requires it. */
export function renderClassExpression(expr: ClassExpr, prefixes: Record<string, string>): string {
  return render(expr, 0);

  function ref(iri: string): string {
    // Defensive against being handed an already-CURIE-shaped (unexpanded) string
    // -- e.g. a live-preview render of a freshly-parsed, not-yet-resolved AST --
    // rather than always assuming `iri` is a full IRI and wrapping non-matches
    // in `<>` (which would otherwise mis-render "ex:Dog" as "<ex:Dog>").
    if (!iri.includes('://')) return iri;
    const curie = shrink(iri, prefixes);
    return curie === iri ? `<${iri}>` : curie;
  }

  function render(e: ClassExpr, parentPrecedence: number): string {
    switch (e.kind) {
      case 'class':
        return ref(e.iri);
      case 'oneOf':
        return `{${e.individuals.map(ref).join(', ')}}`;
      case 'not':
        return wrap(`not ${render(e.operand, 2)}`, 2, parentPrecedence);
      case 'and':
        return wrap(e.operands.map((o) => render(o, 1)).join(' and '), 1, parentPrecedence);
      case 'or':
        return wrap(e.operands.map((o) => render(o, 0)).join(' or '), 0, parentPrecedence);
      case 'restriction':
        return wrap(renderRestriction(e), 2, parentPrecedence);
    }
  }

  function renderRestriction(e: Extract<ClassExpr, { kind: 'restriction' }>): string {
    const p = ref(e.property);
    switch (e.type) {
      case 'self':
        return `${p} Self`;
      case 'value':
        if (e.individual) return `${p} value ${ref(e.individual)}`;
        if (e.literalValue) {
          const lv = e.literalValue;
          const suffix = lv.language ? `@${lv.language}` : lv.datatype ? `^^${ref(lv.datatype)}` : '';
          return `${p} value "${lv.value}"${suffix}`;
        }
        return `${p} value ?`;
      case 'some':
        return `${p} some ${render(e.filler!, 2)}`;
      case 'only':
        return `${p} only ${render(e.filler!, 2)}`;
      case 'min':
      case 'max':
      case 'exactly':
        return `${p} ${e.type} ${e.cardinality}${e.filler ? ` ${render(e.filler, 2)}` : ''}`;
    }
  }

  function wrap(s: string, precedence: number, parentPrecedence: number): string {
    return precedence < parentPrecedence ? `(${s})` : s;
  }
}
