/**
 * Argument checks for the DSL, for code the type checker did not see.
 *
 * A script run without type checking -- with tsx, or as plain JavaScript -- can pass a DSL function
 * anything. Each public function in dsl.ts checks what it is given against what its types say, and
 * refuses the rest with an error naming the function, the argument and what arrived. Unchecked,
 * the same mistakes failed inside the DSL with a TypeError that named nothing the script wrote --
 * `defdatatypeproperty('id', { range: 'xsd:string' })` gave "Cannot convert undefined or null to
 * object" (the SemOps manual's claim C08.15) -- or, worse, wrote an IRI made of `undefined`.
 */

const KIND_NAMES: Record<string, string> = {
  class: 'a class',
  objectProperty: 'an object property',
  datatypeProperty: 'a datatype property',
  individual: 'an individual',
  inverse: 'an inverse property',
  datatype: 'a datatype',
  and: 'a class expression',
  or: 'a class expression',
  not: 'a class expression',
  oneOf: 'a class expression',
  restriction: 'a class expression',
};

const CLASS_EXPRESSION_KINDS = new Set(['class', 'and', 'or', 'not', 'oneOf', 'restriction']);

/** What `value` is, as an error message says it. */
export function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `the ${typeof value} ${String(value)}`;
  if (Array.isArray(value)) return 'a list';
  const kind = kindOf(value);
  if (kind !== undefined) {
    const named = (value as { localName?: unknown }).localName;
    const what = KIND_NAMES[kind] ?? `something of kind "${kind}"`;
    return typeof named === 'string' ? `${what}, ${named}` : what;
  }
  return typeof value === 'object' ? 'an object that is not a term' : `a ${typeof value}`;
}

function kindOf(value: unknown): string | undefined {
  const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
  return typeof kind === 'string' ? kind : undefined;
}

function refuse(where: string, expected: string, value: unknown): never {
  throw new Error(`${where} takes ${expected}, and was given ${describe(value)}.`);
}

/** A term reference as the DSL makes them: `{ kind, iri, localName }`. */
function isRef(value: unknown, kinds: string[]): boolean {
  const v = value as { kind?: unknown; iri?: unknown; localName?: unknown };
  return kinds.includes(kindOf(value) ?? '') && typeof v.iri === 'string' && typeof v.localName === 'string';
}

export function checkString(where: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') refuse(where, 'a non-empty string', value);
}

/** Any string, the empty one included: a default prefix is `''`. */
export function checkText(where: string, value: unknown): void {
  if (typeof value !== 'string') refuse(where, 'a string', value);
}

export function checkList(where: string, value: unknown, expected: string): void {
  if (!Array.isArray(value)) refuse(where, `a list of ${expected}`, value);
}

/** A list (when given at all), each item checked by `check` and named by its position. */
export function checkEach(where: string, value: unknown, expected: string, check: (where: string, value: unknown) => void): void {
  if (value === undefined) return;
  checkList(where, value, expected);
  (value as unknown[]).forEach((item, i) => check(`${where}[${i}]`, item));
}

/** A fact's shape, `[property, value]`; the value is checked against the property's kind where it is used. */
export function checkFact(where: string, value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2) refuse(where, 'a fact: [property, value]', value);
  checkProperty(`${where}[0]`, (value as unknown[])[0]);
}

/** What hasValue takes: an individual, a class standing for the individual with its IRI, or a literal. */
export function checkValue(where: string, value: unknown): void {
  if (typeof value === 'object' && value !== null && 'localName' in value) {
    if (!isRef(value, ['individual', 'class'])) refuse(where, 'an individual or a literal', value);
    return;
  }
  checkLiteral(where, value);
}

export function checkClass(where: string, value: unknown): void {
  if (!isRef(value, ['class'])) refuse(where, 'a class (from defclass or classRef)', value);
}

/** A class, or a class expression from a builder or mx. */
export function checkClassExpression(where: string, value: unknown): void {
  const kind = kindOf(value);
  if (kind === undefined || !CLASS_EXPRESSION_KINDS.has(kind)) refuse(where, 'a class or a class expression', value);
}

export function checkObjectProperty(where: string, value: unknown): void {
  if (!isRef(value, ['objectProperty'])) refuse(where, 'an object property (from defobjectproperty or objectPropertyRef)', value);
}

export function checkDatatypeProperty(where: string, value: unknown): void {
  if (!isRef(value, ['datatypeProperty'])) refuse(where, 'a datatype property (from defdatatypeproperty or datatypePropertyRef)', value);
}

/** What a restriction can be on: a property of either kind, or inverse(property). */
export function checkPropertyExpression(where: string, value: unknown): void {
  const inverseOf = kindOf(value) === 'inverse' ? (value as { of?: unknown }).of : undefined;
  if (!isRef(value, ['objectProperty', 'datatypeProperty']) && !isRef(inverseOf, ['objectProperty'])) {
    refuse(where, 'a property, or inverse(property)', value);
  }
}

/** A property of either kind, as a fact takes. */
export function checkProperty(where: string, value: unknown): void {
  if (!isRef(value, ['objectProperty', 'datatypeProperty'])) refuse(where, 'a property (from defobjectproperty or defdatatypeproperty)', value);
}

export function checkIndividual(where: string, value: unknown): void {
  if (!isRef(value, ['individual'])) refuse(where, 'an individual (from defindividual or individualRef)', value);
}

export function checkDatatype(where: string, value: unknown): void {
  if (kindOf(value) !== 'datatype' || typeof (value as { iri?: unknown }).iri !== 'string') {
    refuse(where, "a datatype, made with datatype('xsd:string') say", value);
  }
}

export function checkCardinality(where: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) refuse(where, 'a whole number, 0 or more', value);
}

/** An options object: absent, or an object that is not a list. */
export function checkOptions(where: string, value: unknown): void {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) refuse(where, 'an options object', value);
}

/** A literal as LiteralValue allows it: a string, number or boolean, or `{ value, language }` or `{ value, datatype }`. */
export function checkLiteral(where: string, value: unknown): void {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  const v = value as { value?: unknown; language?: unknown; datatype?: unknown } | null;
  if (typeof v === 'object' && v !== null && typeof v.value === 'string' && (typeof v.language === 'string' || typeof v.datatype === 'string')) return;
  refuse(where, 'a literal: a string, number or boolean, or { value, language } or { value, datatype }', value);
}

/** One value or a list of them, each checked by `check`. */
function oneOrMany(where: string, value: unknown, check: (where: string, value: unknown) => void): void {
  if (Array.isArray(value)) value.forEach((v, i) => check(`${where}[${i}]`, v));
  else check(where, value);
}

/** The label, comment and annotations that the ontology and every declaration take. */
export function checkAnnotated(where: string, opts: { label?: unknown; comment?: unknown; annotations?: unknown }): void {
  const text = (at: string, v: unknown) => {
    const t = v as { value?: unknown; language?: unknown } | null;
    if (typeof v !== 'string' && !(typeof t === 'object' && t !== null && typeof t.value === 'string' && typeof t.language === 'string')) {
      refuse(at, 'text: a string, or { value, language }', v);
    }
  };
  if (opts.label !== undefined) oneOrMany(`${where}: label`, opts.label, text);
  if (opts.comment !== undefined) oneOrMany(`${where}: comment`, opts.comment, text);
  if (opts.annotations === undefined) return;
  checkOptions(`${where}: annotations`, opts.annotations);
  for (const [property, values] of Object.entries(opts.annotations as Record<string, unknown>)) {
    oneOrMany(`${where}: annotations['${property}']`, values, (at, v) => {
      if (typeof (v as { iri?: unknown } | null)?.iri === 'string') return;
      checkLiteral(at, v);
    });
  }
}
