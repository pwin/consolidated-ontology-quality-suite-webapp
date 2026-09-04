import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './bindAnalysis';

/**
 * The comment masker, against a fixture the Python suite also runs.
 *
 * `stripComments` is not private plumbing. It decides which text rename,
 * find-references and go-to-definition are allowed to touch, and the Python
 * suite's `strip_comments` decides the same thing for `--apply-repairs`. Both
 * shipped the same defect for the same reason -- a scan that skipped a line
 * beginning with `#` but read a trailing comment in full -- so renaming
 * `ex:Dgo` rewrote the comment that explained the rename, turning a true
 * remark into a false one. Both were fixed the same week, independently, in
 * two languages.
 *
 * `registryParity.test.ts` cannot see this. It compares the registry, the
 * shapes, the queries and the repair templates -- shared *data*, character for
 * character. Two hand-written ports of the same algorithm are shared
 * *behaviour*, and nothing compared them. The property that matters is exactly
 * the one nothing checked: given the same text, both must blank the same
 * characters, or a rename that is safe through one tool is unsafe through the
 * other.
 *
 * So the fixture is the statement of intent and both repos carry it. Each side
 * runs its own port against its own copy, which keeps this suite working with
 * only one checkout on the machine, and the last test compares the copies for
 * whoever has both -- which is precisely who makes them disagree.
 *
 * Every `expected` is the same length as its `input`, and that is not
 * decoration. A comment is blanked to spaces rather than removed so that every
 * offset found in the mask still indexes the real document -- which is what
 * lets `curieScan` report a column the editor can select. A port that removed
 * comments instead would pass a naive equality test on the uncommented cases
 * and misplace every range after the first comment.
 */
interface Case {
  name: string;
  why: string;
  input: string;
  expected: string;
}

const FIXTURE_NAME = 'strip-comments-cases.json';
const FIXTURE_PATH = path.join(__dirname, '__fixtures__', FIXTURE_NAME);
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as {
  description: string;
  cases: Case[];
};

/** Where the Python suite keeps its copy, relative to that repo's root. */
const PYTHON_FIXTURE = path.join('tests', 'fixtures', FIXTURE_NAME);

/**
 * The Python copy, if this machine has that checkout. `ONTOLOGY_SUITE_PYTHON`
 * wins so the pair can live anywhere; the sibling directory is the layout both
 * repos are actually developed in. Same resolution order as
 * `registryParity.test.ts`, which looks for the registry rather than this file.
 */
function findPythonFixture(): string | undefined {
  const configured = process.env.ONTOLOGY_SUITE_PYTHON;
  const candidates = [
    ...(configured ? [path.join(configured, PYTHON_FIXTURE)] : []),
    path.resolve(__dirname, '../../../consolidated_ontology_suite_python', PYTHON_FIXTURE),
  ];
  return candidates.find((file) => fs.existsSync(file));
}

describe('stripComments against the shared fixture', () => {
  for (const testCase of fixture.cases) {
    it(`${testCase.name}`, () => {
      expect(stripComments(testCase.input), testCase.why).toBe(testCase.expected);
    });
  }

  it('preserves every offset', () => {
    // Stated separately from the equality above because it is the property the
    // callers rely on, and a failure here says something different: not "the
    // wrong characters were blanked" but "every position after this point is
    // now a lie".
    for (const testCase of fixture.cases) {
      expect(stripComments(testCase.input).length, testCase.name).toBe(testCase.input.length);
    }
  });

  it('still covers the defect that caused this', () => {
    // A fixture is only a guard while the awkward cases are still in it, and
    // the cheapest way to make a suite green is to delete one.
    const names = new Set(fixture.cases.map((c) => c.name));
    expect(names.has('a trailing comment is blanked')).toBe(true);
    expect(names.has('a fragment IRI keeps its local name')).toBe(true);
    expect(names.has('a hash inside a double-quoted literal is not a comment')).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(16);
  });
});

const PYTHON_COPY = findPythonFixture();

describe.skipIf(PYTHON_COPY === undefined)('the Python suite carries the same fixture', () => {
  it('has not drifted', () => {
    // Compared as parsed JSON rather than as bytes: the two repos format and
    // line-end their files by their own conventions, and what has to agree is
    // the cases, not the whitespace between them.
    const theirs = JSON.parse(fs.readFileSync(PYTHON_COPY as string, 'utf8'));
    expect(
      theirs,
      `${FIXTURE_NAME} has drifted between this extension and the Python suite. Whichever ` +
        'copy is right, both must carry it -- each port is checked against its own copy, so ' +
        'a one-sided edit silently stops comparing them.',
    ).toEqual(fixture);
  });
});
