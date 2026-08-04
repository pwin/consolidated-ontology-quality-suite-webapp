import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import * as vscode from 'vscode';
import { DataFactory, Quad } from 'n3';
import * as esbuild from 'esbuild';
import { serializeRdf } from '../rdf/serialization';

const { namedNode, blankNode, literal, quad } = DataFactory;

interface PlainQuad {
  s: string;
  sType: 'NamedNode' | 'BlankNode';
  p: string;
  o: string;
  oType: 'NamedNode' | 'BlankNode' | 'Literal';
  datatype?: string;
  language?: string;
}
type RunnerMessage = { ok: true; quads: PlainQuad[]; prefixes: Record<string, string> } | { ok: false; error: string };

function fromPlainQuad(q: PlainQuad): Quad {
  const subject = q.sType === 'BlankNode' ? blankNode(q.s) : namedNode(q.s);
  const object =
    q.oType === 'BlankNode'
      ? blankNode(q.o)
      : q.oType === 'Literal'
        ? q.language
          ? literal(q.o, q.language)
          : literal(q.o, namedNode(q.datatype ?? 'http://www.w3.org/2001/XMLSchema#string'))
        : namedNode(q.o);
  return quad(subject, namedNode(q.p), object);
}

/**
 * "Ontology Suite: Run Ontology Script" -- runs a `.ontology.ts` script
 * (real TypeScript, using the DSL from scripting/dsl.ts: defclass/
 * defobjectproperty/some/only/and/or/...) in a forked child process (see
 * scriptRunnerEntry.ts for why a real process, not just an isolated scope),
 * and applies the resulting model to a target .ttl file.
 *
 * `.ontology.ts` is a plain .ts file, not a custom language -- deliberately:
 * the whole point of a scripting DSL over a GUI is real IDE support
 * (type-checking, autocomplete, refactoring), which only works if VS Code's
 * built-in TypeScript tooling still owns the file.
 */
export async function runOntologyScript(scriptUri: vscode.Uri, extensionPath: string): Promise<void> {
  const scriptText = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(scriptUri));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontology-suite-script-'));
  const transpiledPath = path.join(tempDir, 'script.cjs');
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Ontology Suite: running ontology script…' }, async () => {
      try {
        await esbuild.build({
          stdin: { contents: scriptText, resolveDir: path.dirname(scriptUri.fsPath), sourcefile: path.basename(scriptUri.fsPath), loader: 'ts' },
          bundle: true,
          platform: 'node',
          format: 'cjs',
          outfile: transpiledPath,
          external: ['ontology-suite/dsl'],
        });
      } catch (err) {
        throw new Error(`Script failed to compile: ${err instanceof Error ? err.message : String(err)}`);
      }

      const runnerPath = path.join(extensionPath, 'dist', 'scriptRunnerEntry.js');
      const result = await new Promise<RunnerMessage>((resolve, reject) => {
        const child = fork(runnerPath, [transpiledPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new Error('Script timed out after 30s.'));
        }, 30000);
        child.on('message', (msg: RunnerMessage) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(msg);
          child.kill();
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(err);
        });
        child.on('exit', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Script process exited with code ${code} before reporting a result (likely an uncaught error -- check for a stray process.exit() or unhandled rejection).`));
        });
      });

      if (!result.ok) throw new Error(result.error);
      await applyScriptResult(scriptUri, result.quads.map(fromPlainQuad), result.prefixes);
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Ontology script failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function applyScriptResult(scriptUri: vscode.Uri, quads: Quad[], prefixes: Record<string, string>): Promise<void> {
  if (quads.length === 0) {
    void vscode.window.showInformationMessage('Ontology script produced no classes/properties (did it call build()-worthy defclass/defobjectproperty calls?).');
    return;
  }

  const defaultTargetName = path.basename(scriptUri.fsPath).replace(/\.ontology\.ts$/, '').replace(/\.ts$/, '') + '.ttl';
  const targetUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(scriptUri.fsPath)), defaultTargetName);

  let targetExists = true;
  try {
    await vscode.workspace.fs.stat(targetUri);
  } catch {
    targetExists = false;
  }

  if (!targetExists) {
    const turtle = await serializeRdf(quads, 'turtle', prefixes);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(turtle, 'utf8'));
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(`Created ${defaultTargetName} from the script (${quads.length} triple(s)).`);
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Append', description: `Add the script's output as new statements in ${defaultTargetName} (safe -- never touches existing content)` },
      { label: 'Replace whole file', description: `Overwrite ${defaultTargetName} entirely with the script's output (loses hand-authored formatting/comments)` },
    ],
    { placeHolder: `${defaultTargetName} already exists -- how should the script's output be applied?` },
  );
  if (!choice) return;

  const doc = await vscode.workspace.openTextDocument(targetUri);
  const editor = await vscode.window.showTextDocument(doc);

  if (choice.label === 'Append') {
    const fragment = await serializeRdf(quads, 'turtle', prefixes);
    const withoutPrefixLines = fragment
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('@prefix'))
      .join('\n')
      .replace(/^\n+/, '');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(targetUri, new vscode.Position(editor.document.lineCount, 0), `\n${withoutPrefixLines}\n`);
    await vscode.workspace.applyEdit(edit);
    void vscode.window.showInformationMessage(`Appended the script's output to ${defaultTargetName} (${quads.length} triple(s)).`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Replace the entire contents of ${defaultTargetName} with this script's output? Hand-authored formatting and comments will be lost.`,
    { modal: true },
    'Replace',
  );
  if (confirm !== 'Replace') return;
  const turtle = await serializeRdf(quads, 'turtle', prefixes);
  const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(targetUri, fullRange, turtle);
  await vscode.workspace.applyEdit(edit);
  void vscode.window.showInformationMessage(`Replaced ${defaultTargetName} with the script's output (${quads.length} triple(s)).`);
}
