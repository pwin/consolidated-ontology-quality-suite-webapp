import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseTurtle, readOntologyDocument } from './rdf/parseDocument';
import { resolveImports } from './ontology/resolveImports';
import { analyzeExpressivity } from './rdf/expressivity';
import { renderMetricsMarkdown } from './ontology/metricsReport';
import { FORMATS, RdfFormat, detectFormat, serializeRdf } from './rdf/serialization';
import { shrink, GIST } from './rdf/vocab';
import {
  newOntologyWizard,
  promptAddClass,
  promptAddProperty,
  renderAddClassTurtle,
  renderAddPropertyTurtle,
  promptClassNameAndLabel,
  promptClassRestriction,
  renderAddClassWithParentsTurtle,
  promptAddSubProperty,
  renderAddSubPropertyTurtle,
} from './ontology/scaffold';
import { OntologyOutlineProvider, OntologyOutlineDragAndDropController, TermOutlineNode } from './ontology/outline';
import { LocalChecksEngine } from './checks/runLocalChecks';
import { OntologySuiteClient } from './cli/ontologySuiteClient';
import { resultRowsToDiagnostics, CHECKS_DIAGNOSTIC_SOURCE } from './checks/toDiagnostics';
import { OntologyRepairCodeActionProvider, APPLY_REPAIR_COMMAND } from './checks/codeActionProvider';
import { computeRepair, RepairOutcome } from './checks/repairEngine';
import { applyRepair } from './checks/applyRepair';
import { loadProjectStandards } from './checks/projectStandards';
import type { ResultRow } from './types';
import { profileCsv, draftFromProfile } from './triplify/csvProfiler';
import { parseCsv } from './triplify/csv';
import { QueryWorkbench } from './webviews/queryWorkbench';
import { openGraphView, focusGraphOnTerm } from './webviews/graphView';
import { TermIndex, findStatementRange } from './language/termIndex';
import { registerHoverProvider } from './language/hover';
import { registerCompletionProvider } from './language/completion';
import { registerManchesterCompletionProvider } from './language/manchesterCompletion';
import { registerDefinitionProvider, registerReferenceProvider, registerRenameProvider } from './language/definitionReferencesRename';
import { registerDocumentSymbolProvider } from './language/documentSymbols';
import { LiveDiagnosticsProvider } from './language/liveDiagnostics';
import { CompetencyQuestionProvider } from './tests/competencyQuestionProvider';
import { runOntologyScript } from './scripting/runScript';
import { organizeDocument } from './ontology/documentSort';

export function activate(context: vscode.ExtensionContext): void {
  const termIndex = new TermIndex();
  const liveDiagnostics = new LiveDiagnosticsProvider();
  const localChecks = new LocalChecksEngine(context.extensionPath);
  const cliClient = new OntologySuiteClient();
  const outlineProvider = new OntologyOutlineProvider();
  const queryWorkbench = new QueryWorkbench();
  const cqProvider = new CompetencyQuestionProvider();
  const cliDiagnostics = vscode.languages.createDiagnosticCollection(`${CHECKS_DIAGNOSTIC_SOURCE}-deep`);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'ontologySuite.showMetrics';

  const outlineDragAndDrop = new OntologyOutlineDragAndDropController(async (dragged, newParent) => {
    const uri = outlineProvider.getActiveUri();
    if (!uri) return;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ?? (await vscode.window.showTextDocument(uri));
    const prefixes = parseTurtle(uri.toString(), editor.document.getText()).prefixes;
    const predicate = dragged.groupKind === 'class' ? 'rdfs:subClassOf' : 'rdfs:subPropertyOf';
    const childCurie = shrink(dragged.term.iri, prefixes);
    const parentCurie = shrink(newParent.term.iri, prefixes);

    const edit = new vscode.WorkspaceEdit();
    const endPos = new vscode.Position(editor.document.lineCount, 0);
    edit.insert(uri, endPos, `\n${childCurie}\n  ${predicate} ${parentCurie} ;\n  .\n`);
    await vscode.workspace.applyEdit(edit);
    outlineProvider.refresh();
    termIndex.invalidate();
    void vscode.window.showInformationMessage(
      `Added ${childCurie} ${predicate} ${parentCurie}. This adds a parent, not a move -- ${childCurie} keeps any existing parent(s) too; edit the file directly to remove one if you want a true reparent.`,
    );
  });
  const outlineTreeView = vscode.window.createTreeView('ontologySuite.outline', { treeDataProvider: outlineProvider, dragAndDropController: outlineDragAndDrop });

  context.subscriptions.push(
    liveDiagnostics,
    localChecks,
    cliClient,
    queryWorkbench,
    cqProvider,
    cliDiagnostics,
    statusBarItem,
    outlineTreeView,
    registerHoverProvider(termIndex),
    registerCompletionProvider(termIndex),
    registerManchesterCompletionProvider(termIndex),
    registerDefinitionProvider(termIndex),
    registerReferenceProvider(termIndex),
    registerRenameProvider(termIndex),
    registerDocumentSymbolProvider(),
    vscode.languages.registerCodeActionsProvider(
      ['turtle', 'trig', 'ntriples', 'nquads'],
      new OntologyRepairCodeActionProvider(() => localChecks.getRepairsRootDir(), localChecks.rowsByDiagnostic),
      { providedCodeActionKinds: OntologyRepairCodeActionProvider.providedCodeActionKinds },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'turtle' || doc.languageId === 'sparql-construct') termIndex.invalidate();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => void updateStatusBar(editor)),
  );
  void updateStatusBar(vscode.window.activeTextEditor);

  async function updateStatusBar(editor: vscode.TextEditor | undefined): Promise<void> {
    const format = editor ? detectFormat(editor.document.uri.fsPath, editor.document.getText()) : undefined;
    if (!editor || !format) {
      statusBarItem.hide();
      return;
    }
    try {
      const parsed = await readOntologyDocument(editor.document.uri.fsPath, editor.document.getText());
      const e = analyzeExpressivity(parsed.quads);
      const profiles = (['EL', 'QL', 'RL'] as const).filter((p) => e.profileMembership[p]).join('/');
      statusBarItem.text = `$(symbol-class) ${e.dlExpressivity}${profiles ? ` (${profiles})` : ''}`;
      statusBarItem.tooltip = 'Ontology Suite: DL expressivity / OWL2 profile membership -- click for full metrics';
      statusBarItem.show();
    } catch {
      statusBarItem.hide();
    }
  }

  /** Editing commands (Add Class/Property) work by textual append, which only makes sense for Turtle. */
  function activeTurtleUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'turtle') {
      void vscode.window.showErrorMessage('Open a .ttl ontology file first.');
      return undefined;
    }
    return editor.document.uri;
  }

  /** Read-oriented commands (checks, metrics, graph view) work for any of the six supported serializations. */
  function activeRdfUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !detectFormat(editor.document.uri.fsPath, editor.document.getText())) {
      void vscode.window.showErrorMessage('Open an ontology file (Turtle, TriG, N-Triples, N-Quads, RDF/XML, or Manchester Syntax) first.');
      return undefined;
    }
    return editor.document.uri;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('ontologySuite.newOntology', async () => {
      const result = await newOntologyWizard();
      if (!result) return;
      await vscode.workspace.fs.writeFile(result.uri, Buffer.from(result.content, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(result.uri);
      await vscode.window.showTextDocument(doc);
      outlineProvider.refresh();
    }),

    vscode.commands.registerCommand('ontologySuite.addClass', async () => {
      const uri = activeTurtleUri();
      if (!uri) return;
      const editor = vscode.window.activeTextEditor!;
      const prefixes = parseTurtle(uri.toString(), editor.document.getText()).prefixes;
      const localPrefix = choosePrimaryPrefix(prefixes);
      const opts = await promptAddClass(localPrefix);
      if (!opts) return;

      const edit = new vscode.WorkspaceEdit();
      if (opts.asCategory && !('gist' in prefixes)) {
        const choice = await vscode.window.showWarningMessage(
          "'gist:' is not declared in this document. Add the prefix declaration too?",
          'Add prefix',
          'Use gist: anyway',
        );
        if (choice === 'Add prefix') {
          edit.insert(uri, new vscode.Position(0, 0), `@prefix gist: <${GIST}> .\n`);
        }
      }
      const endPos = new vscode.Position(editor.document.lineCount, 0);
      edit.insert(uri, endPos, renderAddClassTurtle(opts));
      await vscode.workspace.applyEdit(edit);
      outlineProvider.refresh();
      termIndex.invalidate();
    }),

    vscode.commands.registerCommand('ontologySuite.addProperty', async () => {
      const uri = activeTurtleUri();
      if (!uri) return;
      const editor = vscode.window.activeTextEditor!;
      const prefixes = parseTurtle(uri.toString(), editor.document.getText()).prefixes;
      const localPrefix = choosePrimaryPrefix(prefixes);
      const opts = await promptAddProperty(localPrefix);
      if (!opts) return;
      const edit = new vscode.WorkspaceEdit();
      const endPos = new vscode.Position(editor.document.lineCount, 0);
      edit.insert(uri, endPos, renderAddPropertyTurtle(opts));
      await vscode.workspace.applyEdit(edit);
      outlineProvider.refresh();
      termIndex.invalidate();
    }),

    vscode.commands.registerCommand('ontologySuite.addSubclass', async (node?: TermOutlineNode) => {
      if (!node || node.kind !== 'term') {
        void vscode.window.showErrorMessage('Right-click a class in the Ontology Outline to add a subclass of it.');
        return;
      }
      const uri = outlineProvider.getActiveUri();
      if (!uri) return;
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ?? (await vscode.window.showTextDocument(uri));
      const prefixes = node.prefixes;
      const parentLabel = node.term.label ?? shrink(node.term.iri, prefixes);

      const names = await promptClassNameAndLabel(`subclass of ${parentLabel}`);
      if (!names) return;
      const restrictionExpr = await promptClassRestriction();

      const localPrefix = choosePrimaryPrefix(prefixes);
      const turtle = await renderAddClassWithParentsTurtle(
        { className: names.className, label: names.label, prefix: localPrefix, parentIris: [node.term.iri], restrictionExpr },
        prefixes,
      );
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(editor.document.lineCount, 0), turtle);
      await vscode.workspace.applyEdit(edit);
      outlineProvider.refresh();
      termIndex.invalidate();
    }),

    vscode.commands.registerCommand('ontologySuite.addSiblingClass', async (node?: TermOutlineNode) => {
      if (!node || node.kind !== 'term') {
        void vscode.window.showErrorMessage('Right-click a class in the Ontology Outline to add a sibling of it.');
        return;
      }
      const uri = outlineProvider.getActiveUri();
      if (!uri) return;
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ?? (await vscode.window.showTextDocument(uri));
      const prefixes = node.prefixes;
      const siblingLabel = node.term.label ?? shrink(node.term.iri, prefixes);

      const names = await promptClassNameAndLabel(`sibling of ${siblingLabel}`);
      if (!names) return;
      const restrictionExpr = await promptClassRestriction();

      const localPrefix = choosePrimaryPrefix(prefixes);
      // Same named parent(s) the sibling itself has (possibly none, if the sibling is a root class).
      const turtle = await renderAddClassWithParentsTurtle(
        { className: names.className, label: names.label, prefix: localPrefix, parentIris: node.term.subClassOf, restrictionExpr },
        prefixes,
      );
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(editor.document.lineCount, 0), turtle);
      await vscode.workspace.applyEdit(edit);
      outlineProvider.refresh();
      termIndex.invalidate();
    }),

    vscode.commands.registerCommand('ontologySuite.addSubProperty', async (node?: TermOutlineNode) => {
      if (!node || node.kind !== 'term' || (node.groupKind !== 'objectProperty' && node.groupKind !== 'datatypeProperty')) {
        void vscode.window.showErrorMessage('Right-click an object or datatype property in the Ontology Outline to add a sub-property of it.');
        return;
      }
      const uri = outlineProvider.getActiveUri();
      if (!uri) return;
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ?? (await vscode.window.showTextDocument(uri));
      const prefixes = node.prefixes;
      const parentLabel = node.term.label ?? shrink(node.term.iri, prefixes);
      const kind = node.groupKind === 'objectProperty' ? 'ObjectProperty' : 'DatatypeProperty';

      const names = await promptAddSubProperty(`sub-property of ${parentLabel}`);
      if (!names) return;

      const localPrefix = choosePrimaryPrefix(prefixes);
      const turtle = renderAddSubPropertyTurtle({ propertyName: names.propertyName, label: names.label, kind, prefix: localPrefix, parentIri: node.term.iri }, prefixes);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(editor.document.lineCount, 0), turtle);
      await vscode.workspace.applyEdit(edit);
      outlineProvider.refresh();
      termIndex.invalidate();
    }),

    vscode.commands.registerCommand('ontologySuite.refreshOutline', () => outlineProvider.refresh()),

    // Outline left-click: go to the term's definition (its whole statement highlighted, not just
    // the CURIE token) *and* refocus the graph view (if open, or opened for the first time) on it
    // -- one click, two views of the same term.
    vscode.commands.registerCommand('ontologySuite.revealTerm', async (iri: string) => {
      await termIndex.ensureBuilt();
      const decl = termIndex.getOccurrences(iri).find((o) => o.isDeclaration) ?? termIndex.getOccurrences(iri)[0];
      if (decl) {
        const doc = await vscode.workspace.openTextDocument(decl.uri);
        const editor = await vscode.window.showTextDocument(doc);
        const blockRange = findStatementRange(doc.getText(), decl.range.start.line);
        editor.selection = new vscode.Selection(blockRange.start, blockRange.end);
        editor.revealRange(blockRange, vscode.TextEditorRevealType.InCenter);
      }
      const graphUri = outlineProvider.getActiveUri();
      if (graphUri) {
        await focusGraphOnTerm(graphUri, iri, context.extensionPath);
      }
    }),

    vscode.commands.registerCommand('ontologySuite.openQueryWorkbench', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sparql-construct') {
        void vscode.window.showErrorMessage('Open a .rq CONSTRUCT query file first.');
        return;
      }
      await queryWorkbench.open(editor.document.uri);
    }),

    vscode.commands.registerCommand('ontologySuite.openGraphView', async () => {
      const uri = activeRdfUri();
      if (!uri) return;
      await openGraphView(uri, context.extensionPath);
    }),

    vscode.commands.registerCommand('ontologySuite.runLocalChecks', async () => {
      const uri = activeRdfUri();
      if (!uri) return;
      await localChecks.runForFile(uri);
    }),

    // Every repair is preview-then-apply: computeRepair() only ever computes
    // a candidate edit in memory -- nothing touches the document until the
    // user explicitly confirms *this specific* diff in the modal below.
    // There is no auto-apply / "fix all" path anywhere in the extension.
    vscode.commands.registerCommand(APPLY_REPAIR_COMMAND, async (uri: vscode.Uri, row: ResultRow) => {
      const document = await vscode.workspace.openTextDocument(uri);
      const format = detectFormat(uri.fsPath, document.getText());
      if (!format) return;
      const parsed = await readOntologyDocument(uri.fsPath, document.getText());
      const standards = await loadProjectStandards();
      const outcome = computeRepair(localChecks.getRepairsRootDir(), row, parsed.quads, parsed.prefixes, standards);
      if (!outcome || (outcome.addedQuads.length === 0 && outcome.removedQuads.length === 0)) {
        void vscode.window.showInformationMessage('Ontology Suite: no automatic fix available for this finding (or the underlying triple no longer matches).');
        return;
      }

      const diffLines = describeRepairDiff(outcome, parsed.prefixes);
      const reformatWarning =
        outcome.kind === 'replace' ? '\n\nThis reformats the whole file -- hand-authored formatting and comments will be lost.' : '';
      const choice = await vscode.window.showWarningMessage(
        `Apply fix for ${row.checkId}: ${outcome.title}?\n\n${diffLines}${reformatWarning}`,
        { modal: true },
        'Apply Fix',
      );
      if (choice !== 'Apply Fix') return;

      await applyRepair(document, outcome, parsed.prefixes, format);
      outlineProvider.refresh();
      termIndex.invalidate();
      void vscode.window.showInformationMessage(`Ontology Suite: applied fix -- ${outcome.title}.`);
    }),

    vscode.commands.registerCommand('ontologySuite.showMetrics', async () => {
      const uri = activeRdfUri();
      if (!uri) return;
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      const parsed = await readOntologyDocument(uri.fsPath, text);
      const { mergedQuads } = await resolveImports(uri.fsPath, parsed.quads, path.dirname(uri.fsPath));
      const markdown = renderMetricsMarkdown(parsed.quads.find((q) => q.predicate.value.endsWith('22-rdf-syntax-ns#type'))?.subject.value ?? null, mergedQuads);
      const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }),

    vscode.commands.registerCommand('ontologySuite.inferFromCsv', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv', 'tsv'] } });
      if (!picked || picked.length === 0) return;
      const csvUri = picked[0];
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(csvUri));
      const sample = parseCsv(text, 200);
      const profile = profileCsv(sample);
      const draft = draftFromProfile(csvUri.fsPath, profile);

      const ontologyDoc = await vscode.workspace.openTextDocument({ content: draft.ontologyFragment, language: 'turtle' });
      await vscode.window.showTextDocument(ontologyDoc, { viewColumn: vscode.ViewColumn.One });
      const queryDoc = await vscode.workspace.openTextDocument({ content: draft.constructQuery, language: 'sparql-construct' });
      await vscode.window.showTextDocument(queryDoc, { viewColumn: vscode.ViewColumn.Beside });
      void vscode.window.showInformationMessage('Drafted an ontology fragment and CONSTRUCT query from the CSV -- review, save, and adjust as needed.');
    }),

    vscode.commands.registerCommand('ontologySuite.runDeepValidation', async () => {
      const uri = activeRdfUri();
      if (!uri) return;
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      const parsed = await readOntologyDocument(uri.fsPath, text);
      try {
        const rows = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Ontology Suite: running Python CLI deep validation…' },
          () => cliClient.runChecks(uri.fsPath),
        );
        cliDiagnostics.set(uri, resultRowsToDiagnostics(rows, parsed));
        void vscode.window.showInformationMessage(`Deep validation: ${rows.length} finding(s). See Problems panel.`);
      } catch {
        /* errors already surfaced via the CLI client's own error message / output channel */
      }
    }),

    vscode.commands.registerCommand('ontologySuite.runFullTriplify', async () => {
      const csvDirPick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Select CSV folder' });
      if (!csvDirPick) return;
      const queriesDirPick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Select queries folder' });
      if (!queriesDirPick) return;
      const outDirPick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Select output folder' });
      if (!outDirPick) return;
      try {
        await cliClient.runFullTriplify(csvDirPick[0].fsPath, queriesDirPick[0].fsPath, outDirPick[0].fsPath);
        void vscode.window.showInformationMessage(`Triplify complete: output written to ${outDirPick[0].fsPath}`);
      } catch {
        /* errors already surfaced via the CLI client's own error message / output channel */
      }
    }),

    vscode.commands.registerCommand('ontologySuite.runOntologyScript', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.uri.fsPath.endsWith('.ts')) {
        void vscode.window.showErrorMessage('Open a .ontology.ts script file first (a plain .ts file using the ontology-suite/dsl API -- see TUTORIAL.md).');
        return;
      }
      await runOntologyScript(editor.document.uri, context.extensionPath);
    }),

    vscode.commands.registerCommand('ontologySuite.convertFormat', async () => {
      const uri = activeRdfUri();
      if (!uri) return;
      const sourceFormat = detectFormat(uri.fsPath, vscode.window.activeTextEditor!.document.getText())!;

      const targetPick = await vscode.window.showQuickPick(
        Object.values(FORMATS)
          .filter((f) => f.id !== sourceFormat)
          .map((f) => ({ label: f.label, description: f.extensions[0], id: f.id, losslessGraph: f.losslessGraph })),
        { placeHolder: 'Convert to which serialization?' },
      );
      if (!targetPick) return;
      const targetFormat = (targetPick as { id: RdfFormat }).id;

      if (!FORMATS[targetFormat].losslessGraph) {
        const proceed = await vscode.window.showWarningMessage(
          `${FORMATS[targetFormat].label} only round-trips an OWL-axiom subset (class/property declarations, labels, domain/range, subClassOf/EquivalentTo class expressions, individual types) -- arbitrary other RDF in this document will be dropped. Continue?`,
          'Convert anyway',
          'Cancel',
        );
        if (proceed !== 'Convert anyway') return;
      }

      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      const parsed = await readOntologyDocument(uri.fsPath, text);
      if (parsed.errors.length > 0) {
        const proceed = await vscode.window.showWarningMessage(
          `The source document has ${parsed.errors.length} parse error(s); converting only what parsed successfully. Continue?`,
          'Convert anyway',
          'Cancel',
        );
        if (proceed !== 'Convert anyway') return;
      }

      const converted = await serializeRdf(parsed.quads, targetFormat, parsed.prefixes);
      const targetUri = vscode.Uri.file(replaceExtension(uri.fsPath, FORMATS[targetFormat].extensions[0]));
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(converted, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      void vscode.window.showInformationMessage(`Converted to ${FORMATS[targetFormat].label}: ${targetUri.fsPath}`);
    }),

    vscode.commands.registerCommand('ontologySuite.sortDocumentAlphabetically', () => runOrganizeCommand('alphabetical', false, 'Sort Document (alphabetically)')),
    vscode.commands.registerCommand('ontologySuite.sortDocumentByType', () => runOrganizeCommand('byType', false, 'Sort Document (by type)')),
    vscode.commands.registerCommand('ontologySuite.cleanDocument', () => runOrganizeCommand('byType', true, 'Clean Document')),
  );

  /**
   * Shared handler for Sort Document (alphabetical/by type) and Clean Document (remove unused
   * prefixes, then sort by type) -- unlike every other editing command here, this is a genuine
   * whole-document rewrite, not an append. Safe to do without the append-only pattern's usual
   * append/replace confirmation flow because organizeDocument() never touches statement text
   * itself, only reorders already-verbatim blocks (see ontology/documentSort.ts), and the result
   * is confirmed lossless at the RDF level and comment-preserving by its own test suite -- plus
   * VS Code's own undo stack makes the whole thing a single Ctrl+Z away from reverting regardless.
   */
  function runOrganizeCommand(strategy: 'alphabetical' | 'byType', removeUnusedPrefixes: boolean, label: string): void {
    const uri = activeTurtleUri();
    if (!uri) return;
    const editor = vscode.window.activeTextEditor!;
    const text = editor.document.getText();
    const parsed = parseTurtle(uri.toString(), text);
    if (parsed.errors.length > 0) {
      void vscode.window.showErrorMessage(`${label}: this document has a syntax error and cannot be safely reorganized (${parsed.errors[0].message}).`);
      return;
    }

    const organized = organizeDocument(text, parsed.prefixes, parsed.quads, { removeUnusedPrefixes, sortStrategy: strategy });
    if (organized === text) {
      void vscode.window.showInformationMessage(`${label}: already organized, nothing to change.`);
      return;
    }

    const fullRange = new vscode.Range(0, 0, editor.document.lineCount, 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, organized);
    void vscode.workspace.applyEdit(edit);
  }
}

function replaceExtension(filePath: string, newExt: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(dir, `${base}${newExt}`);
}

const REPAIR_DIFF_PREVIEW_LIMIT = 8;

/** Renders the exact triples a repair would add/remove, CURIE-shrunk, for the confirmation modal -- the user sees precisely what's about to change before authorizing it. */
function describeRepairDiff(outcome: RepairOutcome, prefixes: Record<string, string>): string {
  const term = (t: import('n3').Quad['object']): string => {
    if (t.termType === 'Literal') {
      const lit = t as import('n3').Literal;
      return lit.language ? `"${lit.value}"@${lit.language}` : `"${lit.value}"`;
    }
    return shrink(t.value, prefixes);
  };
  const renderQuad = (q: import('n3').Quad) => `${shrink(q.subject.value, prefixes)} ${shrink(q.predicate.value, prefixes)} ${term(q.object)}`;

  const lines: string[] = [];
  for (const q of outcome.removedQuads.slice(0, REPAIR_DIFF_PREVIEW_LIMIT)) lines.push(`- ${renderQuad(q)}`);
  for (const q of outcome.addedQuads.slice(0, REPAIR_DIFF_PREVIEW_LIMIT)) lines.push(`+ ${renderQuad(q)}`);
  const shown = Math.min(outcome.removedQuads.length, REPAIR_DIFF_PREVIEW_LIMIT) + Math.min(outcome.addedQuads.length, REPAIR_DIFF_PREVIEW_LIMIT);
  const total = outcome.removedQuads.length + outcome.addedQuads.length;
  if (total > shown) lines.push(`… and ${total - shown} more`);
  return lines.join('\n');
}

function choosePrimaryPrefix(prefixes: Record<string, string>): string {
  const wellKnown = new Set(['rdf', 'rdfs', 'owl', 'skos', 'xsd', 'sh', 'dcterms', 'gist']);
  const candidates = Object.keys(prefixes).filter((p) => p && !wellKnown.has(p));
  return candidates[0] ?? Object.keys(prefixes)[0] ?? '';
}

export function deactivate(): void {
  /* all disposables are registered on context.subscriptions and disposed by VS Code */
}
