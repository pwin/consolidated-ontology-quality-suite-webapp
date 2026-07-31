import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseTurtle } from './rdf/parseDocument';
import { resolveImports } from './ontology/resolveImports';
import { analyzeExpressivity } from './rdf/expressivity';
import { renderMetricsMarkdown } from './ontology/metricsReport';
import { newOntologyWizard, promptAddClass, promptAddProperty, renderAddClassTurtle, renderAddPropertyTurtle } from './ontology/scaffold';
import { OntologyOutlineProvider } from './ontology/outline';
import { LocalChecksEngine } from './checks/runLocalChecks';
import { OntologySuiteClient } from './cli/ontologySuiteClient';
import { resultRowsToDiagnostics, CHECKS_DIAGNOSTIC_SOURCE } from './checks/toDiagnostics';
import { profileCsv, draftFromProfile } from './triplify/csvProfiler';
import { parseCsv } from './triplify/csv';
import { QueryWorkbench } from './webviews/queryWorkbench';
import { openGraphView } from './webviews/graphView';
import { TermIndex } from './language/termIndex';
import { registerHoverProvider } from './language/hover';
import { registerCompletionProvider } from './language/completion';
import { registerDefinitionProvider, registerReferenceProvider, registerRenameProvider } from './language/definitionReferencesRename';
import { registerDocumentSymbolProvider } from './language/documentSymbols';
import { LiveDiagnosticsProvider } from './language/liveDiagnostics';
import { CompetencyQuestionProvider } from './tests/competencyQuestionProvider';

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

  context.subscriptions.push(
    liveDiagnostics,
    localChecks,
    cliClient,
    queryWorkbench,
    cqProvider,
    cliDiagnostics,
    statusBarItem,
    vscode.window.registerTreeDataProvider('ontologySuite.outline', outlineProvider),
    registerHoverProvider(termIndex),
    registerCompletionProvider(termIndex),
    registerDefinitionProvider(termIndex),
    registerReferenceProvider(termIndex),
    registerRenameProvider(termIndex),
    registerDocumentSymbolProvider(),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'turtle' || doc.languageId === 'sparql-construct') termIndex.invalidate();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => void updateStatusBar(editor)),
  );
  void updateStatusBar(vscode.window.activeTextEditor);

  async function updateStatusBar(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.languageId !== 'turtle') {
      statusBarItem.hide();
      return;
    }
    try {
      const parsed = parseTurtle(editor.document.uri.toString(), editor.document.getText());
      const e = analyzeExpressivity(parsed.quads);
      const profiles = (['EL', 'QL', 'RL'] as const).filter((p) => e.profileMembership[p]).join('/');
      statusBarItem.text = `$(symbol-class) ${e.dlExpressivity}${profiles ? ` (${profiles})` : ''}`;
      statusBarItem.tooltip = 'Ontology Suite: DL expressivity / OWL2 profile membership -- click for full metrics';
      statusBarItem.show();
    } catch {
      statusBarItem.hide();
    }
  }

  function activeTurtleUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'turtle') {
      void vscode.window.showErrorMessage('Open a .ttl ontology file first.');
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
          edit.insert(uri, new vscode.Position(0, 0), '@prefix gist: <https://w3id.org/semanticarts/ns/ontology/gist/> .\n');
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

    vscode.commands.registerCommand('ontologySuite.refreshOutline', () => outlineProvider.refresh()),

    vscode.commands.registerCommand('ontologySuite.revealTerm', async (iri: string) => {
      await termIndex.ensureBuilt();
      const decl = termIndex.getOccurrences(iri).find((o) => o.isDeclaration) ?? termIndex.getOccurrences(iri)[0];
      if (!decl) return;
      const doc = await vscode.workspace.openTextDocument(decl.uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(decl.range.start, decl.range.end);
      editor.revealRange(decl.range, vscode.TextEditorRevealType.InCenter);
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
      const uri = activeTurtleUri();
      if (!uri) return;
      await openGraphView(uri);
    }),

    vscode.commands.registerCommand('ontologySuite.runLocalChecks', async () => {
      const uri = activeTurtleUri();
      if (!uri) return;
      await localChecks.runForFile(uri);
    }),

    vscode.commands.registerCommand('ontologySuite.showMetrics', async () => {
      const uri = activeTurtleUri();
      if (!uri) return;
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      const parsed = parseTurtle(uri.toString(), text);
      const { mergedQuads } = resolveImports(uri.fsPath, parsed.quads, path.dirname(uri.fsPath));
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
      const uri = activeTurtleUri();
      if (!uri) return;
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      const parsed = parseTurtle(uri.toString(), text);
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
  );
}

function choosePrimaryPrefix(prefixes: Record<string, string>): string {
  const wellKnown = new Set(['rdf', 'rdfs', 'owl', 'skos', 'xsd', 'sh', 'dcterms', 'gist']);
  const candidates = Object.keys(prefixes).filter((p) => p && !wellKnown.has(p));
  return candidates[0] ?? Object.keys(prefixes)[0] ?? '';
}

export function deactivate(): void {
  /* all disposables are registered on context.subscriptions and disposed by VS Code */
}
