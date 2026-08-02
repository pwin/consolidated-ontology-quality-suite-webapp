import * as path from 'node:path';
import * as vscode from 'vscode';
import { readOntologyDocument } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';

interface CqDirectives {
  expectBoolean?: boolean;
  expectMinRows?: number;
  against?: string[];
}

/**
 * Competency questions as VS Code tests: a `.cq.rq` file is a SPARQL
 * ASK/SELECT query with expected-result directives in a leading comment
 * block, run through the native Test Explorer via Oxigraph -- red/green,
 * CI-friendly ontology/data correctness testing instead of a one-shot
 * batch report (see the plan's "Differentiators").
 *
 * Directive syntax (one per leading `#`-comment line):
 *   # @expect: true|false        -- for ASK queries
 *   # @expect-min-rows: N        -- for SELECT queries
 *   # @against: relative/path.ttl[,other.ttl]  -- defaults to any .ttl file(s) in the same folder
 */
export class CompetencyQuestionProvider implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController('ontologySuite.competencyQuestions', 'Competency Questions');
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.controller.resolveHandler = async (item) => {
      if (!item) await this.discoverAll();
    };
    this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runHandler(request, token),
      true,
    );
    this.disposables.push(
      vscode.workspace.onDidCreateFiles(() => this.discoverAll()),
      vscode.workspace.onDidDeleteFiles(() => this.discoverAll()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.fsPath.endsWith('.cq.rq')) this.discoverAll();
      }),
    );
    void this.discoverAll();
  }

  dispose(): void {
    this.controller.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private async discoverAll(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.cq.rq', '**/node_modules/**');
    this.controller.items.replace(
      files.map((uri) => this.controller.createTestItem(uri.toString(), path.basename(uri.fsPath), uri)),
    );
  }

  private async runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.controller.createTestRun(request);
    const items: vscode.TestItem[] = [];
    if (request.include) items.push(...request.include);
    else this.controller.items.forEach((i) => items.push(i));

    for (const item of items) {
      if (token.isCancellationRequested) break;
      if (!item.uri) continue;
      run.started(item);
      try {
        const result = await this.evaluate(item.uri);
        if (result.passed) run.passed(item, result.durationMs);
        else run.failed(item, new vscode.TestMessage(result.message), result.durationMs);
      } catch (err) {
        run.errored(item, new vscode.TestMessage(err instanceof Error ? err.message : String(err)));
      }
    }
    run.end();
  }

  private async evaluate(uri: vscode.Uri): Promise<{ passed: boolean; message: string; durationMs: number }> {
    const start = Date.now();
    const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
    const directives = parseDirectives(text);

    const dataQuads = await this.loadAgainst(uri, directives.against);

     
    const oxigraph = require('oxigraph') as typeof import('oxigraph');
    const store = new oxigraph.Store();
    store.load(serializeQuadsAsNTriples(dataQuads), { format: 'application/n-triples' });

    let queryResult: unknown;
    try {
      queryResult = store.query(text);
    } catch (err) {
      return { passed: false, message: `Query failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - start };
    }

    if (typeof queryResult === 'boolean') {
      const expected = directives.expectBoolean ?? true;
      return {
        passed: queryResult === expected,
        message: `ASK returned ${queryResult}, expected ${expected}.`,
        durationMs: Date.now() - start,
      };
    }
    if (Array.isArray(queryResult)) {
      const minRows = directives.expectMinRows ?? 1;
      const passed = queryResult.length >= minRows;
      return {
        passed,
        message: `SELECT returned ${queryResult.length} row(s), expected at least ${minRows}.`,
        durationMs: Date.now() - start,
      };
    }
    return { passed: false, message: 'Query must be ASK or SELECT for a competency-question test.', durationMs: Date.now() - start };
  }

  private async loadAgainst(cqUri: vscode.Uri, against: string[] | undefined): Promise<import('n3').Quad[]> {
    const dir = path.dirname(cqUri.fsPath);
    const targetPaths = against && against.length > 0 ? against.map((p) => path.resolve(dir, p)) : await defaultOntologyFiles(dir);

    const allQuads: import('n3').Quad[] = [];
    for (const filePath of targetPaths) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        const parsed = await readOntologyDocument(filePath, new TextDecoder('utf-8').decode(bytes));
        const { mergedQuads } = await resolveImports(filePath, parsed.quads, path.dirname(filePath));
        allQuads.push(...mergedQuads);
      } catch {
        /* missing @against file -- surfaced implicitly via an empty/failing test result */
      }
    }
    return allQuads;
  }
}

async function defaultOntologyFiles(dir: string): Promise<string[]> {
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(dir), '*.ttl'), undefined, 10);
  return files.map((f) => f.fsPath);
}

function parseDirectives(text: string): CqDirectives {
  const directives: CqDirectives = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) {
      if (trimmed.length > 0) break; // directives must be a leading comment block
      continue;
    }
    const expectMatch = /@expect:\s*(true|false)/i.exec(trimmed);
    if (expectMatch) directives.expectBoolean = expectMatch[1].toLowerCase() === 'true';
    const minRowsMatch = /@expect-min-rows:\s*(\d+)/i.exec(trimmed);
    if (minRowsMatch) directives.expectMinRows = Number(minRowsMatch[1]);
    const againstMatch = /@against:\s*(.+)/i.exec(trimmed);
    if (againstMatch) directives.against = againstMatch[1].split(',').map((s) => s.trim());
  }
  return directives;
}

function serializeQuadsAsNTriples(quads: import('n3').Quad[]): string {
   
  const { Writer } = require('n3') as typeof import('n3');
  const writer = new Writer({ format: 'N-Triples' });
  writer.addQuads(quads);
  let out = '';
  writer.end((_err, result) => {
    out = result;
  });
  return out;
}
