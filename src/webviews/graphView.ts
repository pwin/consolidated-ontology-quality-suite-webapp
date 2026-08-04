import * as path from 'node:path';
import * as vscode from 'vscode';
import { readOntologyDocument } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { generateDot, GraphOptions, GraphRankdir } from '../graph/dotGenerator';
import { renderDotToSvg } from '../graph/vizRenderer';
import { renderSvgToPng } from '../graph/pngRenderer';
import { shrink } from '../rdf/vocab';
import { htmlShell } from './webviewUtil';

export async function openGraphView(fileUri: vscode.Uri, extensionPath: string): Promise<void> {
  const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(fileUri));
  const doc = await readOntologyDocument(fileUri.fsPath, text);
  const { mergedQuads } = await resolveImports(fileUri.fsPath, doc.quads, path.dirname(fileUri.fsPath));
  // The main document's own subjects (pre-import-merge) -- used by hideImportedDownstream to
  // tell "declared here" from "only reachable via an import" without a second import-resolution pass.
  const localSubjects = new Set(doc.quads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value));

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

  const options: GraphOptions = {
    hideTypes: false,
    hideAnnotations: false,
    hideIsDefinedBy: false,
    hideImportedDownstream: false,
    showPrefixes: true,
    maxDepth: 3,
    rankdir: 'LR',
  };
  // Tracked so the download handlers always save the SVG actually on screen right now, not
  // whatever was current when the handler was registered.
  let currentSvg = '';
  const baseName = path.basename(fileUri.fsPath, path.extname(fileUri.fsPath));

  const render = () => renderInto(panel, mergedQuads, selected, doc.prefixes, options, localSubjects).then((svg) => (currentSvg = svg));
  await render();

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type: string;
      hideTypes?: boolean;
      hideAnnotations?: boolean;
      hideIsDefinedBy?: boolean;
      hideImportedDownstream?: boolean;
      rankdir?: GraphRankdir;
      dataUrl?: string;
    }) => {
      if (msg.type === 'toggle') {
        options.hideTypes = msg.hideTypes ?? options.hideTypes;
        options.hideAnnotations = msg.hideAnnotations ?? options.hideAnnotations;
        options.hideIsDefinedBy = msg.hideIsDefinedBy ?? options.hideIsDefinedBy;
        options.hideImportedDownstream = msg.hideImportedDownstream ?? options.hideImportedDownstream;
        options.rankdir = msg.rankdir ?? options.rankdir;
        await render();
      } else if (msg.type === 'downloadSvg') {
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? fileUri, `${baseName}-graph.svg`),
          filters: { 'SVG image': ['svg'] },
        });
        if (!saveUri) return;
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(currentSvg, 'utf8'));
        void vscode.window.showInformationMessage(`Graph saved to ${saveUri.fsPath}`);
      } else if (msg.type === 'downloadPng') {
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? fileUri, `${baseName}-graph.png`),
          filters: { 'PNG image': ['png'] },
        });
        if (!saveUri) return;
        try {
          const png = await renderSvgToPng(currentSvg, extensionPath);
          await vscode.workspace.fs.writeFile(saveUri, png);
          // Opens the saved PNG in a new editor tab -- VS Code's built-in image preview covers
          // "view", so downloading and viewing are the same action instead of two separate UIs.
          await vscode.commands.executeCommand('vscode.open', saveUri);
        } catch (err) {
          void vscode.window.showErrorMessage(`PNG conversion failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  );
}

async function renderInto(
  panel: vscode.WebviewPanel,
  quads: import('n3').Quad[],
  selected: string[],
  prefixes: Record<string, string>,
  options: GraphOptions,
  localSubjects: ReadonlySet<string>,
): Promise<string> {
  const dot = generateDot(quads, selected, prefixes, options, localSubjects);
  let svg: string;
  let renderFailed = false;
  try {
    svg = await renderDotToSvg(dot);
  } catch (err) {
    renderFailed = true;
    svg = `<pre>Graph rendering failed: ${err instanceof Error ? err.message : String(err)}</pre>`;
  }

  const rankdirOption = (value: GraphRankdir, label: string) => `<option value="${value}" ${options.rankdir === value ? 'selected' : ''}>${label}</option>`;

  const body = /* html */ `
<div class="panel">
  <div class="toolbar">
    <label><input type="checkbox" id="hideTypes" ${options.hideTypes ? 'checked' : ''}/> Hide rdf:type edges</label>
    <label><input type="checkbox" id="hideAnnotations" ${options.hideAnnotations ? 'checked' : ''}/> Hide annotation edges</label>
    <label><input type="checkbox" id="hideIsDefinedBy" ${options.hideIsDefinedBy ? 'checked' : ''}/> Hide rdfs:isDefinedBy edges</label>
    <label><input type="checkbox" id="hideImportedDownstream" ${options.hideImportedDownstream ? 'checked' : ''}/> Hide imported terms' downstream</label>
    <label>Direction:
      <select id="rankdir">
        ${rankdirOption('LR', 'Left → Right')}
        ${rankdirOption('RL', 'Right → Left')}
        ${rankdirOption('TB', 'Top → Bottom')}
        ${rankdirOption('BT', 'Bottom → Top')}
      </select>
    </label>
    <span style="flex: 1"></span>
    <button id="zoomOut" title="Zoom out">−</button>
    <button id="zoomReset" title="Reset zoom">Reset</button>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="downloadSvg" ${renderFailed ? 'disabled' : ''}>Download SVG</button>
    <button id="downloadPng" ${renderFailed ? 'disabled' : ''}>Download PNG</button>
  </div>
  <div class="zoom-viewport" id="viewport">
    <div class="zoom-layer" id="layer">${svg}</div>
  </div>
  <div class="zoom-hint">Scroll/pinch to zoom, drag to pan. "Hide imported terms' downstream" keeps a referenced imported class/property visible as a leaf, but doesn't expand its own further connections.</div>
</div>`;

  const script = `
const vscode = acquireVsCodeApi();
document.getElementById('hideTypes').addEventListener('change', postToggle);
document.getElementById('hideAnnotations').addEventListener('change', postToggle);
document.getElementById('hideIsDefinedBy').addEventListener('change', postToggle);
document.getElementById('hideImportedDownstream').addEventListener('change', postToggle);
document.getElementById('rankdir').addEventListener('change', postToggle);
document.getElementById('downloadSvg').addEventListener('click', () => vscode.postMessage({ type: 'downloadSvg' }));
document.getElementById('downloadPng').addEventListener('click', () => vscode.postMessage({ type: 'downloadPng' }));
function postToggle() {
  vscode.postMessage({
    type: 'toggle',
    hideTypes: document.getElementById('hideTypes').checked,
    hideAnnotations: document.getElementById('hideAnnotations').checked,
    hideIsDefinedBy: document.getElementById('hideIsDefinedBy').checked,
    hideImportedDownstream: document.getElementById('hideImportedDownstream').checked,
    rankdir: document.getElementById('rankdir').value,
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
