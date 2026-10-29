import * as fs from 'node:fs';
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
import { runMalformedChecks, withoutRelativeIris } from './malformed';
import { runVocabularyChecks } from './vocabularyChecks';
import { evaluateClassRules } from './classRules';
import { loadClassRulesConfig } from './classRulesLoader';
import { mergeResultRows } from './merge';
import { dominantCheck } from './findingSummary';
import { applyPolicy, describeChange, EXTENSION_CHECK_IDS, loadPolicy, nothingChangedWarning, PolicyError, PolicyTarget, resolveStage, validateStage } from './severityPolicy';
import { CHECKS_DIAGNOSTIC_SOURCE, resultRowsToDiagnostics } from './toDiagnostics';
import type { ResultRow } from '../types';

/** Where a project's severity policy is looked for when `ontologySuite.severityPolicy` is left alone. */
const DEFAULT_SEVERITY_POLICY = '.ontology-suite/severity-policy.json';

/** A severity policy resolved to one stage and checked against the ids this run can report. */
export interface ActiveSeverityPolicy {
  path: string;
  stage: string;
  targets: Map<string, PolicyTarget>;
}

export class LocalChecksEngine {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(CHECKS_DIAGNOSTIC_SOURCE);
  /** The audit trail for severity policies: every re-mapping, on every run that made one. */
  private readonly policyOutput = vscode.window.createOutputChannel('Ontology Suite (Severity Policy)');
  private registryCache: { rootDir: string; registry: Registry } | undefined;
  /** Diagnostic identity -> the ResultRow it was rendered from, so the Quick Fix CodeActionProvider can recover focusNode/path/value without re-parsing the diagnostic message. */
  readonly rowsByDiagnostic = new WeakMap<vscode.Diagnostic, ResultRow>();

  constructor(private readonly extensionPath: string) {}

  dispose(): void {
    this.diagnostics.dispose();
    this.policyOutput.dispose();
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

  /**
   * The severity policy a run on `fileUri` applies (see severityPolicy.ts): undefined when the
   * project has none, and 'refused' when it has one that cannot be applied whole. The user has been
   * told why by then, and the run should not go ahead -- findings shown without the policy someone
   * asked for would read as findings with it.
   *
   * `ontologySuite.severityPolicy` is resolved against the file's workspace folder. Its default
   * location is optional, the way `.ontology-suite/class-rules.json` is; a path someone set is not,
   * and neither is a stage named when there is no policy to take it from.
   */
  severityPolicyForRun(fileUri: vscode.Uri, runName: string): ActiveSeverityPolicy | undefined | 'refused' {
    const config = vscode.workspace.getConfiguration('ontologySuite');
    const configured = config.get<string>('severityPolicy', DEFAULT_SEVERITY_POLICY).trim();
    const stringency = config.get<string>('stringency', '').trim() || undefined;
    try {
      if (!configured) {
        if (stringency) throw new PolicyError(`ontologySuite.stringency is '${stringency}', but ontologySuite.severityPolicy is empty: there is no policy to take a stage from`);
        return undefined;
      }
      const base = vscode.workspace.getWorkspaceFolder(fileUri)?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(fileUri.fsPath);
      const policyPath = path.resolve(base, configured);
      if (configured === DEFAULT_SEVERITY_POLICY && !stringency && !fs.existsSync(policyPath)) return undefined;

      const { stage, resolved } = resolveStage(loadPolicy(policyPath), stringency);
      const targets = validateStage(resolved, [...this.getRegistry().checksById.keys(), ...EXTENSION_CHECK_IDS]);
      return { path: policyPath, stage, targets };
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      this.policyOutput.appendLine(`${runName}: refused. ${err.message}`);
      void vscode.window.showErrorMessage(`Ontology Suite: ${runName} did not run, because the severity policy cannot be applied. ${err.message}`);
      return 'refused';
    }
  }

  /**
   * Applies a policy to one run's rows and returns them with a sentence for the run's summary.
   * Every re-mapping is written to the policy's output channel on the run that made it: a policy
   * that quietly changed what a run reports is the thing it is designed against.
   */
  applySeverityPolicy(rows: ResultRow[], policy: ActiveSeverityPolicy, runName: string): { rows: ResultRow[]; note: string } {
    const { rows: kept, changes } = applyPolicy(rows, policy.targets);
    this.policyOutput.appendLine(`${runName}: severity policy '${policy.stage}' from ${policy.path}: ${changes.length} check(s) re-mapped`);
    for (const change of changes) this.policyOutput.appendLine(`  ${describeChange(change)}`);
    if (changes.length) return { rows: kept, note: `Severity policy '${policy.stage}' re-mapped ${changes.length} check(s).` };
    this.policyOutput.appendLine(`  Warning: ${nothingChangedWarning(policy.stage, policy.targets.size)}`);
    return { rows: kept, note: `Severity policy '${policy.stage}' changed nothing; see its output channel.` };
  }

  async runForFile(fileUri: vscode.Uri): Promise<void> {
    // Before any check runs: a run the policy refuses has nothing to show for the work.
    const policy = this.severityPolicyForRun(fileUri, 'Run Local Checks');
    if (policy === 'refused') return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Ontology Suite: running local checks…', cancellable: false },
      async (progress) => {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder('utf-8').decode(bytes);
        const doc = await readOntologyDocument(fileUri.fsPath, text);

        progress.report({ message: 'resolving imports', increment: 10 });
        const { mergedQuads: resolvedQuads } = await resolveImports(fileUri.fsPath, doc.quads, path.dirname(fileUri.fsPath));

        // Malformed OWL that this extension's own earlier versions could write (see malformed.ts).
        // A relative IRI is reported there and left out of what the engines below are given:
        // holosdb refuses a graph with one in it, and that refusal used to fail the whole run.
        const malformedRows = runMalformedChecks(resolvedQuads as Quad[]);
        const mergedQuads = withoutRelativeIris(resolvedQuads as Quad[]);

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
        let sparqlRows: ResultRow[] = [];
        if (sparqlEnabled) {
          // As the SHACL tier below: a store that refuses the graph costs this tier, not the run.
          try {
            sparqlRows = [...runSparqlChecks(mergedQuads, registry, disabledChecks), ...runLiteralTypingChecks(mergedQuads as Quad[])];
          } catch (err) {
            console.error('[ontologySuite] SPARQL check run failed:', err);
          }
        }

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
        const merged = mergeResultRows(sparqlRows, shaclRows, reasoningRows, guidanceRows, vocabularyRows, projectRuleRows, malformedRows)
          .filter((row) => !(row.checkId !== null && disabledChecks.has(row.checkId)));
        // After the merge, as in the Python suite: a check that ran as both a shape and a query
        // is one row by now, so the policy cannot re-map half of it.
        const { rows, note } = policy ? this.applySeverityPolicy(merged, policy, 'Run Local Checks') : { rows: merged, note: '' };
        const fileDiagnostics = resultRowsToDiagnostics(rows, doc, this.rowsByDiagnostic);
        this.diagnostics.set(fileUri, fileDiagnostics);

        progress.report({ message: 'done', increment: 10 });
        const violations = rows.filter((r) => r.severity === 'Violation').length;
        const warnings = rows.filter((r) => r.severity === 'Warning').length;
        void this.report(rows, violations, warnings, disabledChecks, note);
      },
    );
  }

  /**
   * The run's summary, plus a way out when one check is most of it.
   *
   * A check that encodes a convention rather than a defect reports once per term,
   * so on a graph it does not suit it does not add findings, it *is* the findings
   * -- QUA-009/QUA-010 ask for SKOS documentation and produce 52 on an ontology
   * documented with rdfs:label. `ontologySuite.disabledChecks` answers that, but a
   * setting nobody knows about answers nothing, so the id doing the flooding is
   * named here and offered directly.
   */
  private async report(rows: ResultRow[], violations: number, warnings: number, disabled: ReadonlySet<string>, policyNote: string): Promise<void> {
    const summary = `Ontology Suite: ${rows.length} finding(s) (${violations} violation(s), ${warnings} warning(s)). ${policyNote ? `${policyNote} ` : ''}See Problems panel.`;

    const flooding = dominantCheck(rows, disabled);
    if (!flooding) {
      void vscode.window.showInformationMessage(summary);
      return;
    }
    const { checkId: dominant, count } = flooding;

    const title = this.getRegistry().checksById.get(dominant)?.title ?? dominant;
    const action = `Disable ${dominant}`;
    const choice = await vscode.window.showInformationMessage(
      `${summary} ${count} of them are ${dominant} (${title}).`,
      action,
    );
    if (choice !== action) return;

    const config = vscode.workspace.getConfiguration('ontologySuite');
    const current = config.get<string[]>('disabledChecks', []);
    if (current.includes(dominant)) return;
    // Workspace where there is one, so the choice travels with the project rather
    // than silencing the check in every other ontology this user opens.
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config.update('disabledChecks', [...current, dominant], target);
    void vscode.window.showInformationMessage(
      `Ontology Suite: ${dominant} disabled in ${target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user'} settings. Run Local Checks again to clear its findings.`,
    );
  }
}

