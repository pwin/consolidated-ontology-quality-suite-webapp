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
  // Tracked so the 'download' message handler always saves the SVG actually on screen right now,
  // not whatever was current when the handler was registered.
  let currentSvg = '';
  const suggestedFileName = `${path.basename(fileUri.fsPath, path.extname(fileUri.fsPath))}-graph.svg`;

  const render = () => renderInto(panel, mergedQuads, selected, doc.prefixes, options).then((svg) => (currentSvg = svg));
  await render();

  panel.webview.onDidReceiveMessage(async (msg: { type: string; hideTypes?: boolean; hideAnnotations?: boolean }) => {
    if (msg.type === 'toggle') {
      options.hideTypes = msg.hideTypes ?? options.hideTypes;
      options.hideAnnotations = msg.hideAnnotations ?? options.hideAnnotations;
      await render();
    } else if (msg.type === 'download') {
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? fileUri, suggestedFileName),
        filters: { 'SVG image': ['svg'] },
      });
      if (!saveUri) return;
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(currentSvg, 'utf8'));
      void vscode.window.showInformationMessage(`Graph saved to ${saveUri.fsPath}`);
    }
  });
}

async function renderInto(
  panel: vscode.WebviewPanel,
  quads: import('n3').Quad[],
  selected: string[],
  prefixes: Record<string, string>,
  options: GraphOptions,
): Promise<string> {
  const dot = generateDot(quads, selected, prefixes, options);
  let svg: string;
  let renderFailed = false;
  try {
    svg = await renderDotToSvg(dot);
  } catch (err) {
    renderFailed = true;
    svg = `<pre>Graph rendering failed: ${err instanceof Error ? err.message : String(err)}</pre>`;
  }

  const body = /* html */ `
<div class="panel">
  <div class="toolbar">
    <label><input type="checkbox" id="hideTypes" ${options.hideTypes ? 'checked' : ''}/> Hide rdf:type edges</label>
    <label><input type="checkbox" id="hideAnnotations" ${options.hideAnnotations ? 'checked' : ''}/> Hide annotation edges</label>
    <span style="flex: 1"></span>
    <button id="zoomOut" title="Zoom out">−</button>
    <button id="zoomReset" title="Reset zoom">Reset</button>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="download" ${renderFailed ? 'disabled' : ''}>Download SVG</button>
  </div>
  <div class="zoom-viewport" id="viewport">
    <div class="zoom-layer" id="layer">${svg}</div>
  </div>
  <div class="zoom-hint">Scroll/pinch to zoom, drag to pan.</div>
</div>`;

  const script = `
const vscode = acquireVsCodeApi();
document.getElementById('hideTypes').addEventListener('change', postToggle);
document.getElementById('hideAnnotations').addEventListener('change', postToggle);
document.getElementById('download').addEventListener('click', () => vscode.postMessage({ type: 'download' }));
function postToggle() {
  vscode.postMessage({
    type: 'toggle',
    hideTypes: document.getElementById('hideTypes').checked,
    hideAnnotations: document.getElementById('hideAnnotations').checked,
  });
}

// Minimal hand-rolled pan/zoom: a CSS transform on #layer inside a fixed, overflow-hidden
// #viewport. No pan/zoom library involved -- the webview's CSP only allows this page's own
// nonce'd inline script, no CDN/bundled dependency to load.
(function () {
  const viewport = document.getElementById('viewport');
  const layer = document.getElementById('layer');
  let scale = 1, x = 0, y = 0;
  const MIN_SCALE = 0.2, MAX_SCALE = 8;

  function apply() {
    layer.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewport.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    // Keep the point under the cursor fixed on screen while scaling.
    x = px - ((px - x) / scale) * newScale;
    y = py - ((py - y) / scale) * newScale;
    scale = newScale;
    apply();
  }

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  document.getElementById('zoomIn').addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
  });
  document.getElementById('zoomReset').addEventListener('click', () => {
    scale = 1; x = 0; y = 0; apply();
  });

  let dragging = false, lastX = 0, lastY = 0;
  viewport.addEventListener('mousedown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    viewport.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    x += e.clientX - lastX; y += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    apply();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    viewport.classList.remove('grabbing');
  });

  apply();
})();`;

  panel.webview.html = htmlShell(panel.webview, 'Ontology Graph', body, script);
  return svg;
}
