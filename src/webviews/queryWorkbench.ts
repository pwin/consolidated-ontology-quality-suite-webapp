import * as vscode from 'vscode';
import { readOntologyDocument } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { sketchQuery, renderSketchTurtle } from '../triplify/sketch';
import { checkAlignment } from '../triplify/prefixAlignment';
import { evaluatePreview } from '../triplify/previewEvaluator';
import { findOntologies, findPair, resolveOntologyPatterns } from '../triplify/discovery';
import { parseCsv } from '../triplify/csv';
import { htmlShell } from './webviewUtil';
import * as path from 'node:path';

const DEBOUNCE_MS = 500;

export class QueryWorkbench implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private queryUri: vscode.Uri | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.queryUri && e.document.uri.toString() === this.queryUri.toString()) this.scheduleRefresh();
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
  }

  async open(queryUri: vscode.Uri): Promise<void> {
    this.queryUri = queryUri;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('ontologySuite.queryWorkbench', 'Ontology Suite: Query Workbench', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    await this.refresh();
  }

  private scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }

  private async refresh(): Promise<void> {
    if (!this.panel || !this.queryUri) return;
    const queryText = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(this.queryUri));

    const sketch = sketchQuery(queryText);
    const sketchTurtle = renderSketchTurtle([sketch]);

    const csvPath = findPair(this.queryUri.fsPath);
    let previewTurtle = '';
    let previewError: string | undefined;
    let rowsUsed = 0;
    let skippedColumns: string[] = [];

    // Every resolved ontology contributes: an extension ontology plus the upper
    // ontology it builds on is the normal case, not an edge case. Each is
    // import-resolved in its own right, then all merged, so a term declared in any
    // of them counts as declared for the conformance check.
    const ontologyPaths = resolveOntologyPaths(this.queryUri);
    let ontologyQuads: import('n3').Quad[] = [];
    const ontologyPrefixes: Record<string, string> = {};
    for (const ontologyPath of ontologyPaths) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(ontologyPath));
        const parsed = await readOntologyDocument(ontologyPath, new TextDecoder('utf-8').decode(bytes));
        const resolved = await resolveImports(ontologyPath, parsed.quads, path.dirname(ontologyPath));
        ontologyQuads = [...ontologyQuads, ...resolved.mergedQuads];
        // First binding wins, so an earlier ontology's prefix isn't silently rebound
        // by a later one that spells the same prefix differently.
        for (const [prefix, iri] of Object.entries(parsed.prefixes)) {
          if (!(prefix in ontologyPrefixes)) ontologyPrefixes[prefix] = iri;
        }
      } catch (err) {
        console.error(`[ontologySuite] could not read ontology ${ontologyPath} for conformance checking:`, err);
      }
    }

    if (csvPath) {
      const sampleSize = vscode.workspace.getConfiguration('ontologySuite').get<number>('triplifyPreviewSampleSize', 20);
      const csvText = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.file(csvPath)));
      const sample = parseCsv(csvText, sampleSize);
      const result = evaluatePreview(queryText, sample, ontologyQuads);
      previewTurtle = result.turtle;
      previewError = result.error;
      rowsUsed = result.rowsUsed;
      skippedColumns = result.skippedColumns;
    }

    const alignment = ontologyQuads.length > 0 ? checkAlignment(queryText, ontologyPrefixes, ontologyQuads) : undefined;

    this.render(sketchTurtle, csvPath, previewTurtle, previewError, rowsUsed, skippedColumns, alignment);
  }

  private render(
    sketchTurtle: string,
    csvPath: string | undefined,
    previewTurtle: string,
    previewError: string | undefined,
    rowsUsed: number,
    skippedColumns: string[],
    alignment: ReturnType<typeof checkAlignment> | undefined,
  ): void {
    if (!this.panel) return;
    const esc = escapeHtml;

    let conformanceHtml = '<p><em>No ontology found alongside this query -- conformance checking skipped.</em></p>';
    if (alignment) {
      const items: string[] = [];
      for (const m of alignment.prefixMisalignments) {
        items.push(`<li><span class="badge Warning">${m.kind}</span> ${esc(m.detail)}</li>`);
      }
      for (const t of alignment.undeclaredTerms) {
        items.push(`<li><span class="badge Info">undeclared ${t.kind}</span> ${esc(t.term)}</li>`);
      }
      conformanceHtml = items.length > 0 ? `<ul>${items.join('')}</ul>` : '<p>No prefix drift or undeclared classes/properties detected.</p>';
    }

    const previewHtml = previewError
      ? `<p style="color: var(--vscode-errorForeground)">Preview error: ${esc(previewError)}</p>`
      : csvPath
        ? `<p>Evaluated against ${rowsUsed} sample row(s) from <code>${esc(path.basename(csvPath))}</code>.${skippedColumns.length ? ` Skipped column(s) with non-variable-safe names: ${skippedColumns.map(esc).join(', ')}.` : ''}</p><pre>${esc(previewTurtle) || '(no triples produced)'}</pre>`
        : '<p><em>No linked CSV found (filename convention: same stem, .csv/.tsv) -- showing static sketch only.</em></p>';

    const body = /* html */ `
<div class="panel">
  <h2>Live triplify preview</h2>
  ${previewHtml}
  <h2>Query sketch (static, no data required)</h2>
  <pre>${esc(sketchTurtle)}</pre>
  <h2>Conformance against ontology</h2>
  ${conformanceHtml}
</div>`;
    this.panel.webview.html = htmlShell(this.panel.webview, 'Query Workbench', body, '');
  }
}

/**
 * The ontology file(s) this query is checked for conformance against.
 *
 * `ontologySuite.queryOntologyPaths` wins when set -- paths are absolute or
 * resolved against the workspace root -- because no heuristic can be right for
 * every layout, and being able to say so beats being guessed at. Otherwise
 * triplify/discovery.ts's `findOntologies` looks where this repo's own layouts
 * put them (own directory, then parent, then siblings).
 *
 * Until 0.11.1 this took the first `*.ttl` in the query's own directory and
 * nothing else, so `examples/tutorial/queries/appointments.rq` -- whose ontology
 * is one level up -- silently got no conformance checking at all, and a project
 * built on several ontologies only ever saw one of them.
 */
function resolveOntologyPaths(queryUri: vscode.Uri): string[] {
  const configured = vscode.workspace.getConfiguration('ontologySuite').get<string[]>('queryOntologyPaths', []);
  if (configured.length > 0) {
    const root = vscode.workspace.getWorkspaceFolder(queryUri)?.uri.fsPath ?? path.dirname(queryUri.fsPath);
    // Entries are independent: each is either a literal path or a glob, and the
    // two mix freely in one list -- pin the two ontologies you author by name,
    // then sweep up `vocab/*_ontology.ttl` alongside them.
    return resolveOntologyPatterns(configured, root);
  }
  return findOntologies(queryUri.fsPath);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
