import * as path from 'node:path';
import * as vscode from 'vscode';
import { Quad } from 'n3';
import { readOntologyDocument } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { loadRegistry, Registry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';
import { runLiteralTypingChecks } from './literalTyping';
import { runShaclChecks } from './shaclRunner';
import { runReasoningChecks } from './reasoningRunner';
import { runModellingGuidance } from './modellingGuidance';
import { runVocabularyChecks } from './vocabularyChecks';
import { evaluateClassRules } from './classRules';
import { loadClassRulesConfig } from './classRulesLoader';
import { mergeResultRows } from './merge';
import { CHECKS_DIAGNOSTIC_SOURCE, resultRowsToDiagnostics } from './toDiagnostics';
import type { ResultRow } from '../types';

export class LocalChecksEngine {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(CHECKS_DIAGNOSTIC_SOURCE);
  private registryCache: { rootDir: string; registry: Registry } | undefined;
  /** Diagnostic identity -> the ResultRow it was rendered from, so the Quick Fix CodeActionProvider can recover focusNode/path/value without re-parsing the diagnostic message. */
  readonly rowsByDiagnostic = new WeakMap<vscode.Diagnostic, ResultRow>();

  constructor(private readonly extensionPath: string) {}

  dispose(): void {
    this.diagnostics.dispose();
  }

  private getRegistryRootDir(): string {
    const configured = vscode.workspace.getConfiguration('ontologySuite').get<string>('checksRegistryPath', '');
    return configured && configured.trim().length > 0 ? configured : path.join(this.extensionPath, 'resources', 'checks-registry');
  }

  /** Directory containing the repair (*.ru) templates + manifest.json used by checks/repairEngine.ts. */
  getRepairsRootDir(): string {
    return path.join(this.getRegistryRootDir(), 'repairs');
  }

  private getRegistry(): Registry {
    const rootDir = this.getRegistryRootDir();
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
        const sparqlEnabled = config.get<boolean>('enableSparqlChecks', true);
        const shaclEnabled = config.get<boolean>('enableShaclChecks', true);
        const vocabularyEnabled = config.get<boolean>('enableVocabularyChecks', true);
        // Per-check opt-out, for the checks that encode a convention rather than a
        // defect: QUA-009/QUA-010 ask for SKOS documentation on every term, which an
        // ontology documented with rdfs:label does not have and may not want.
        const disabledChecks = new Set(config.get<string[]>('disabledChecks', []));

        // Both engines are now fast enough that neither toggle is worth reaching for in an
        // ordinary edit/check loop: SHACL-SPARQL runs via shacl-wasm (see shaclRunner.ts),
        // which does the six shapes files over examples/ontology/domain.ttl in ~0.3s where
        // the previous shacl-engine took ~71s for the identical 11 findings. They stay
        // configurable for the cases where a caller genuinely wants one tier only.
        progress.report({ message: 'sparql checks', increment: 20 });
        // Value-space validation supplements the registry's two regex-based DAT-001
        // formulations, which can only test a lexical form -- see literalTyping.ts.
        // Gated with the SPARQL tier because it is the same check id, reported from
        // the same source, and merges under the normal dedup key.
        const sparqlRows = sparqlEnabled
          ? [...runSparqlChecks(mergedQuads, registry, disabledChecks), ...runLiteralTypingChecks(mergedQuads as Quad[])]
          : [];

        progress.report({ message: 'shacl checks', increment: 20 });
        let shaclRows: ResultRow[] = [];
        if (shaclEnabled) {
          try {
            shaclRows = runShaclChecks(mergedQuads as Quad[], registry);
          } catch (err) {
            console.error('[ontologySuite] SHACL check run failed:', err);
          }
        }

        progress.report({ message: 'reasoning', increment: 20 });
        const rulesPath = path.join(this.extensionPath, 'resources', 'reasoning', 'core-rules.n3');
        const reasoningRows = await runReasoningChecks(mergedQuads as Quad[], rulesPath).catch((err) => {
           
          console.error('[ontologySuite] reasoning run failed:', err);
          return [];
        });

        progress.report({ message: 'modelling guidance', increment: 20 });
        const guidanceRows = guidanceMode === 'off' ? [] : runModellingGuidance(mergedQuads);

        const vocabularyRows = vocabularyEnabled ? runVocabularyChecks(mergedQuads as Quad[]) : [];

        const classRulesConfig = await loadClassRulesConfig();
        const projectRuleRows = evaluateClassRules(mergedQuads, classRulesConfig, doc.prefixes);

        // Filtered after the merge, not before: a disabled id may still arrive from
        // the SHACL tier (a shapes file is compiled whole, so one shape cannot be
        // skipped the way its SPARQL twin's query file can) or from the reasoner.
        const merged = mergeResultRows(sparqlRows, shaclRows, reasoningRows, guidanceRows, vocabularyRows, projectRuleRows)
          .filter((row) => !(row.checkId !== null && disabledChecks.has(row.checkId)));
        const fileDiagnostics = resultRowsToDiagnostics(merged, doc, this.rowsByDiagnostic);
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
