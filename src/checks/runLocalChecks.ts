import * as path from 'node:path';
import * as vscode from 'vscode';
import { Quad } from 'n3';
import { readOntologyDocument } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { loadRegistry, Registry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';
import { runShaclChecks } from './shaclRunner';
import { runReasoningChecks } from './reasoningRunner';
import { runModellingGuidance } from './modellingGuidance';
import { mergeResultRows } from './merge';
import { CHECKS_DIAGNOSTIC_SOURCE, resultRowsToDiagnostics } from './toDiagnostics';

export class LocalChecksEngine {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(CHECKS_DIAGNOSTIC_SOURCE);
  private registryCache: { rootDir: string; registry: Registry } | undefined;

  constructor(private readonly extensionPath: string) {}

  dispose(): void {
    this.diagnostics.dispose();
  }

  private getRegistry(): Registry {
    const configured = vscode.workspace.getConfiguration('ontologySuite').get<string>('checksRegistryPath', '');
    const rootDir = configured && configured.trim().length > 0 ? configured : path.join(this.extensionPath, 'resources', 'checks-registry');
    if (this.registryCache?.rootDir === rootDir) return this.registryCache.registry;
    const registry = loadRegistry(rootDir);
    this.registryCache = { rootDir, registry };
    return registry;
  }

  async runForFile(fileUri: vscode.Uri): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Ontology Suite: running local checks…', cancellable: false },
      async (progress) => {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder('utf-8').decode(bytes);
        const doc = await readOntologyDocument(fileUri.fsPath, text);

        progress.report({ message: 'resolving imports', increment: 10 });
        const { mergedQuads } = await resolveImports(fileUri.fsPath, doc.quads, path.dirname(fileUri.fsPath));

        const registry = this.getRegistry();
        const config = vscode.workspace.getConfiguration('ontologySuite');
        const guidanceMode = config.get<string>('modellingGuidance', 'gist');

        progress.report({ message: 'sparql checks', increment: 20 });
        const sparqlRows = runSparqlChecks(mergedQuads, registry);

        progress.report({ message: 'shacl checks', increment: 20 });
        const shaclRows = await runShaclChecks(mergedQuads, registry).catch((err) => {
           
          console.error('[ontologySuite] SHACL check run failed:', err);
          return [];
        });

        progress.report({ message: 'reasoning', increment: 20 });
        const rulesPath = path.join(this.extensionPath, 'resources', 'reasoning', 'core-rules.n3');
        const reasoningRows = await runReasoningChecks(mergedQuads as Quad[], rulesPath).catch((err) => {
           
          console.error('[ontologySuite] reasoning run failed:', err);
          return [];
        });

        progress.report({ message: 'modelling guidance', increment: 20 });
        const guidanceRows = guidanceMode === 'off' ? [] : runModellingGuidance(mergedQuads);

        const merged = mergeResultRows(sparqlRows, shaclRows, reasoningRows, guidanceRows);
        const fileDiagnostics = resultRowsToDiagnostics(merged, doc);
        this.diagnostics.set(fileUri, fileDiagnostics);

        progress.report({ message: 'done', increment: 10 });
        const violations = merged.filter((r) => r.severity === 'Violation').length;
        const warnings = merged.filter((r) => r.severity === 'Warning').length;
        void vscode.window.showInformationMessage(
          `Ontology Suite: ${merged.length} finding(s) (${violations} violation(s), ${warnings} warning(s)). See Problems panel.`,
        );
      },
    );
  }
}
