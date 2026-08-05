import * as path from 'node:path';
import * as vscode from 'vscode';
import { Quad } from 'n3';
import { readOntologyDocument } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { generateDot, quadKey, GraphOptions, GraphRankdir } from '../graph/dotGenerator';
import { renderDotToSvg } from '../graph/vizRenderer';
import { renderSvgToPng } from '../graph/pngRenderer';
import { computeInferredClosure, OQR } from '../checks/reasoningRunner';
import { shrink } from '../rdf/vocab';
import { htmlShell } from './webviewUtil';

interface GraphSource {
  mergedQuads: Quad[];
  localSubjects: ReadonlySet<string>;
  prefixes: Record<string, string>;
}

interface ActiveGraphState extends GraphSource {
  panel: vscode.WebviewPanel;
  fileUri: string;
  extensionPath: string;
  rulesPath: string;
  baseName: string;
  selected: string[];
  options: GraphOptions;
  showInferred: boolean;
  // Computed lazily (EYE reasoner startup + run has real cost -- see reasoningRunner.ts's own
  // notes elsewhere in this project) and cached for as long as the source data doesn't change --
  // invalidated whenever the panel is rebuilt against a freshly re-read file.
  inferredCache: { combinedQuads: Quad[]; inferredKeys: Set<string> } | undefined;
  // Tracked so the download handlers always save the SVG actually on screen right now, not
  // whatever was current when the handler was registered.
  currentSvg: string;
}

// At most one graph panel is extension-managed at a time -- both the manual "Visualize Subject
// Graph" command and outline-click-driven visualization retarget this same panel/tab instead of
// each opening their own, so browsing terms in the Outline doesn't pile up webview tabs.
let activeGraph: ActiveGraphState | undefined;

async function loadGraphSource(fileUri: vscode.Uri): Promise<GraphSource & { prefixes: Record<string, string> }> {
  const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(fileUri));
  const doc = await readOntologyDocument(fileUri.fsPath, text);
  const { mergedQuads } = await resolveImports(fileUri.fsPath, doc.quads, path.dirname(fileUri.fsPath));
  // The main document's own subjects (pre-import-merge) -- used by hideImportedDownstream to
  // tell "declared here" from "only reachable via an import" without a second import-resolution pass.
  const localSubjects = new Set(doc.quads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value));
  return { mergedQuads, localSubjects, prefixes: doc.prefixes };
}

/** Manually-invoked entry point: prompts for which subject(s) to visualize via QuickPick. */
export async function openGraphView(fileUri: vscode.Uri, extensionPath: string): Promise<void> {
  const source = activeGraph && activeGraph.fileUri === fileUri.toString() ? activeGraph : await loadGraphSource(fileUri);
  const subjects = Array.from(new Set(source.mergedQuads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value))).sort();
  if (subjects.length === 0) {
    void vscode.window.showInformationMessage('No named subjects found in this document.');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    subjects.map((s) => ({ label: shrink(s, source.prefixes), description: s, iri: s })),
    { canPickMany: true, placeHolder: 'Select subject(s) to visualize (defaults to the first 10 if none picked)' },
  );
  const selected = picks && picks.length > 0 ? picks.map((p) => (p as { iri: string }).iri) : subjects.slice(0, 10);
  await showGraph(fileUri, extensionPath, selected, { preserveFocus: false });
}

/**
 * Outline-click entry point: jumps straight to a single term's neighborhood, no QuickPick.
 * Retargets the one extension-managed graph panel (opening it on first use) rather than a
 * fresh tab per click -- see `activeGraph` above.
 */
export async function focusGraphOnTerm(fileUri: vscode.Uri, iri: string, extensionPath: string): Promise<void> {
  await showGraph(fileUri, extensionPath, [iri], { preserveFocus: true });
}

async function showGraph(fileUri: vscode.Uri, extensionPath: string, selected: string[], revealOpts: { preserveFocus: boolean }): Promise<void> {
  if (activeGraph && activeGraph.fileUri === fileUri.toString()) {
    activeGraph.selected = selected;
    await renderGraph(activeGraph);
    activeGraph.panel.reveal(undefined, revealOpts.preserveFocus);
    return;
  }
  const source = await loadGraphSource(fileUri);
  // Switching to a different file -- close the old panel rather than leaving it and its
  // now-stale merged quads/imports lying around as a second tab.
  activeGraph?.panel.dispose();
  await createGraphPanel(fileUri, extensionPath, source, selected, revealOpts.preserveFocus);
}

async function createGraphPanel(
  fileUri: vscode.Uri,
  extensionPath: string,
  source: GraphSource,
  selected: string[],
  preserveFocus: boolean,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'ontologySuite.graphView',
    'Ontology Suite: Graph',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const state: ActiveGraphState = {
    panel,
    fileUri: fileUri.toString(),
    extensionPath,
    rulesPath: path.join(extensionPath, 'resources', 'reasoning', 'core-rules.n3'),
    baseName: path.basename(fileUri.fsPath, path.extname(fileUri.fsPath)),
    mergedQuads: source.mergedQuads,
    localSubjects: source.localSubjects,
    prefixes: source.prefixes,
    selected,
    options: { hideTypes: false, hideAnnotations: false, hideIsDefinedBy: false, hideImportedDownstream: false, showPrefixes: true, maxDepth: 3, rankdir: 'LR' },
    showInferred: false,
    inferredCache: undefined,
    currentSvg: '',
  };
  activeGraph = state;
  panel.onDidDispose(() => {
    if (activeGraph === state) activeGraph = undefined;
  });

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type: string;
      hideTypes?: boolean;
      hideAnnotations?: boolean;
      hideIsDefinedBy?: boolean;
      hideImportedDownstream?: boolean;
      showInferred?: boolean;
      rankdir?: GraphRankdir;
      dataUrl?: string;
    }) => {
      if (msg.type === 'toggle') {
        state.options.hideTypes = msg.hideTypes ?? state.options.hideTypes;
        state.options.hideAnnotations = msg.hideAnnotations ?? state.options.hideAnnotations;
        state.options.hideIsDefinedBy = msg.hideIsDefinedBy ?? state.options.hideIsDefinedBy;
        state.options.hideImportedDownstream = msg.hideImportedDownstream ?? state.options.hideImportedDownstream;
        state.options.rankdir = msg.rankdir ?? state.options.rankdir;
        const inferredJustEnabled = msg.showInferred === true && !state.showInferred;
        state.showInferred = msg.showInferred ?? state.showInferred;
        if (inferredJustEnabled) {
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Ontology Suite: computing reasoner closure…' }, () =>
            renderGraph(state),
          );
        } else {
          await renderGraph(state);
        }
      } else if (msg.type === 'downloadSvg') {
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? fileUri, `${state.baseName}-graph.svg`),
          filters: { 'SVG image': ['svg'] },
        });
        if (!saveUri) return;
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(state.currentSvg, 'utf8'));
        void vscode.window.showInformationMessage(`Graph saved to ${saveUri.fsPath}`);
      } else if (msg.type === 'downloadPng') {
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? fileUri, `${state.baseName}-graph.png`),
          filters: { 'PNG image': ['png'] },
        });
        if (!saveUri) return;
        try {
          const png = await renderSvgToPng(state.currentSvg, state.extensionPath);
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

  await renderGraph(state);
}

async function getGraphQuads(state: ActiveGraphState): Promise<{ quads: Quad[]; inferredKeys: Set<string> | undefined }> {
  if (!state.showInferred) return { quads: state.mergedQuads, inferredKeys: undefined };
  if (!state.inferredCache) {
    const closure = await computeInferredClosure(state.mergedQuads, state.rulesPath);
    const assertedKeys = new Set(state.mergedQuads.map(quadKey));
    // Excludes reasoningRunner.ts's own internal contradiction-bookkeeping triples (the OQR
    // namespace) -- real for the checks engine's own purposes, but not genuine domain-level
    // ontology vocabulary, so showing them here would look like a confusing false inference
    // rather than what actually happened (e.g. "rex is inferred to be a Dog").
    const isBookkeeping = (q: Quad) => q.subject.value.startsWith(OQR) || q.predicate.value.startsWith(OQR) || q.object.value.startsWith(OQR);
    const inferredOnly = closure.filter((q) => !assertedKeys.has(quadKey(q)) && !isBookkeeping(q));
    const inferredKeys = new Set(inferredOnly.map(quadKey));
    // The combined graph (asserted + inferred-only) is what generateDot needs to actually draw
    // the inferred edges -- inferredKeys alone only says *which* edges to style differently.
    state.inferredCache = { combinedQuads: [...state.mergedQuads, ...inferredOnly], inferredKeys };
  }
  return { quads: state.inferredCache.combinedQuads, inferredKeys: state.inferredCache.inferredKeys };
}

async function renderGraph(state: ActiveGraphState): Promise<void> {
  // Reflects the currently-focused term in the tab title, so retargeting an already-open panel
  // (e.g. clicking around the Outline) is visibly confirmed rather than a silent no-op.
  state.panel.title = state.selected.length === 1 ? `Ontology Suite: Graph — ${shrink(state.selected[0], state.prefixes)}` : 'Ontology Suite: Graph';
  const { quads, inferredKeys } = await getGraphQuads(state);
  state.currentSvg = await renderInto(state.panel, quads, state.selected, state.prefixes, state.options, state.localSubjects, inferredKeys);
}

async function renderInto(
  panel: vscode.WebviewPanel,
  quads: Quad[],
  selected: string[],
  prefixes: Record<string, string>,
  options: GraphOptions,
  localSubjects: ReadonlySet<string>,
  inferredKeys: ReadonlySet<string> | undefined,
): Promise<string> {
  const dot = generateDot(quads, selected, prefixes, options, localSubjects, inferredKeys);
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
    <label title="Runs the EYE reasoner (core-rules.n3) and overlays anything it can derive that isn't directly asserted, as dashed purple edges"><input type="checkbox" id="showInferred" ${inferredKeys ? 'checked' : ''}/> Show inferred (reasoner closure)</label>
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
  <div class="zoom-hint">Scroll/pinch to zoom, drag to pan. "Hide imported terms' downstream" keeps a referenced imported class/property visible as a leaf, but doesn't expand its own further connections.${inferredKeys ? ' <span style="color: purple">Dashed purple edges</span> are reasoner-inferred, not directly asserted.' : ''}</div>
</div>`;

  const script = `
const vscode = acquireVsCodeApi();
document.getElementById('hideTypes').addEventListener('change', postToggle);
document.getElementById('hideAnnotations').addEventListener('change', postToggle);
document.getElementById('hideIsDefinedBy').addEventListener('change', postToggle);
document.getElementById('hideImportedDownstream').addEventListener('change', postToggle);
document.getElementById('showInferred').addEventListener('change', postToggle);
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
    showInferred: document.getElementById('showInferred').checked,
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
