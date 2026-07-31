import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseCsv } from '../triplify/csv';
import type { ResultRow, Severity } from '../types';

/**
 * Optional deep-validation / full-triplify backend: shells out to the
 * existing Python `ontology-suite` CLI (consolidated_ontology_suite) for
 * whatever the in-process JS/WASM engines don't cover -- full OWL2 DL
 * reasoning (owlready2/HermiT), docgen, version-diff, and the real
 * `oxi-gen` triplifier. Entirely optional: absent gracefully if the CLI
 * isn't found, since the local checks engine (checks/runLocalChecks.ts)
 * already covers the SPARQL/SHACL/OWL2-RL-ish/guidance tier with zero
 * external runtime dependency.
 */
export class OntologySuiteClient {
  private readonly output = vscode.window.createOutputChannel('Ontology Suite (Python CLI)');

  dispose(): void {
    this.output.dispose();
  }

  private cliPath(): string {
    return vscode.workspace.getConfiguration('ontologySuite').get<string>('pythonCliPath', 'ontology-suite');
  }

  async runChecks(ontologyPath: string, dataPaths: string[] = []): Promise<ResultRow[]> {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-suite-'));
    const args = ['run', '--ontology', ontologyPath, '--out-dir', outDir];
    for (const d of dataPaths) args.push('--data', d);

    await this.exec(args);

    const csvPath = path.join(outDir, 'full_results.csv');
    if (!fs.existsSync(csvPath)) {
      void vscode.window.showWarningMessage('Ontology Suite CLI ran but produced no full_results.csv -- check the output channel.');
      return [];
    }
    return parseResultsCsv(fs.readFileSync(csvPath, 'utf8'));
  }

  async runFullTriplify(csvDir: string, queriesDir: string, outDir: string): Promise<void> {
    await this.exec(['triplify', '--csv-dir', csvDir, '--queries', queriesDir, '--out-dir', outDir]);
  }

  private exec(args: string[]): Promise<void> {
    const cli = this.cliPath();
    this.output.show(true);
    this.output.appendLine(`$ ${cli} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(cli, args, { shell: process.platform === 'win32' });
      proc.stdout.on('data', (d: Buffer) => this.output.append(d.toString()));
      proc.stderr.on('data', (d: Buffer) => this.output.append(d.toString()));
      proc.on('error', (err) => {
        this.output.appendLine(`\nFailed to launch '${cli}': ${err.message}`);
        void vscode.window.showErrorMessage(
          `Could not run the ontology-suite CLI ('${cli}'). Install consolidated_ontology_suite and/or set ontologySuite.pythonCliPath, or use the in-process "Run Local Checks" command instead.`,
        );
        reject(err);
      });
      proc.on('close', (code) => {
        this.output.appendLine(`\n(exit code ${code})`);
        if (code === 0) resolve();
        else reject(new Error(`ontology-suite exited with code ${code}`));
      });
    });
  }
}

function parseResultsCsv(csvText: string): ResultRow[] {
  const { rows } = parseCsv(csvText);
  return rows.map((r) => ({
    checkId: r.check_id === 'UNMAPPED' ? null : r.check_id || null,
    category: r.category === 'unmapped' ? null : r.category || null,
    title: r.title || null,
    severity: (r.severity as Severity) || 'Info',
    focusNode: r.focus_node ?? '',
    path: r.path || null,
    value: r.value || null,
    message: r.message ?? '',
    remediation: r.remediation || null,
    sources: r.sources ? r.sources.split('+') : ['python-cli'],
  }));
}
