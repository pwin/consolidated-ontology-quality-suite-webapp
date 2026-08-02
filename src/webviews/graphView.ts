import * as path from 'node:path';
import * as vscode from 'vscode';
import { readOntologyDocument } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { generateDot, GraphOptions } from '../graph/dotGenerator';
import { renderDotToSvg } from '../graph/vizRenderer';
import { shrink } from '../rdf/vocab';
import { htmlShell } from './webviewUtil';

export async function openGraphView(fileUri: vscode.Uri): Promise<void> {
  const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(fileUri));
  const doc = await readOntologyDocument(fileUri.fsPath, text);
  const { mergedQuads } = await resolveImports(fileUri.fsPath, doc.quads, path.dirname(fileUri.fsPath));

  const subjects = Array.from(new Set(mergedQuads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value))).sort();
  if (subjects.length === 0) {
    void vscode.window.showInformationMessage('No named subjects found in this document.');
    return;
  }

  const picks = await vscode.window.showQuickPick(
    subjects.map((s) => ({ label: shrink(s, doc.prefixes), description: s, iri: s })),
    { canPickMany: true, placeHolder: 'Select subject(s) to visualize (defaults to the first 10 if none picked)' },
  );
  const selected = picks && picks.length > 0 ? picks.map((p) => (p as { iri: string }).iri) : subjects.slice(0, 10);

  const panel = vscode.window.createWebviewPanel('ontologySuite.graphView', 'Ontology Suite: Graph', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const options: GraphOptions = { hideTypes: false, hideAnnotations: false, showPrefixes: true, maxDepth: 3 };
  await renderInto(panel, mergedQuads, selected, doc.prefixes, options);

  panel.webview.onDidReceiveMessage(async (msg: { type: string; hideTypes?: boolean; hideAnnotations?: boolean }) => {
    if (msg.type === 'toggle') {
      options.hideTypes = msg.hideTypes ?? options.hideTypes;
      options.hideAnnotations = msg.hideAnnotations ?? options.hideAnnotations;
      await renderInto(panel, mergedQuads, selected, doc.prefixes, options);
    }
  });
}

async function renderInto(
  panel: vscode.WebviewPanel,
  quads: import('n3').Quad[],
  selected: string[],
  prefixes: Record<string, string>,
  options: GraphOptions,
): Promise<void> {
  const dot = generateDot(quads, selected, prefixes, options);
  let svg: string;
  try {
    svg = await renderDotToSvg(dot);
  } catch (err) {
    svg = `<pre>Graph rendering failed: ${err instanceof Error ? err.message : String(err)}</pre>`;
  }

  const body = /* html */ `
<div class="panel">
  <div>
    <label><input type="checkbox" id="hideTypes" ${options.hideTypes ? 'checked' : ''}/> Hide rdf:type edges</label>
    &nbsp;&nbsp;
    <label><input type="checkbox" id="hideAnnotations" ${options.hideAnnotations ? 'checked' : ''}/> Hide annotation edges</label>
  </div>
  <div class="svg-container">${svg}</div>
</div>`;

  const script = `
const vscode = acquireVsCodeApi();
document.getElementById('hideTypes').addEventListener('change', post);
document.getElementById('hideAnnotations').addEventListener('change', post);
function post() {
  vscode.postMessage({
    type: 'toggle',
    hideTypes: document.getElementById('hideTypes').checked,
    hideAnnotations: document.getElementById('hideAnnotations').checked,
  });
}`;

  panel.webview.html = htmlShell(panel.webview, 'Ontology Graph', body, script);
}
