import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Read from the manifest rather than written out, because writing it out is how
 * this suite came to be dead. It was pinned to `local.ontology-dev-suite` while
 * the publisher was `pwin`, so `suiteSetup` failed on every run from 0.2.0 to
 * 0.13.0 and no test in this file ever executed -- and the whole point of the
 * file is to be the one place where the *packaged* extension is exercised.
 */
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
  publisher: string;
  name: string;
};
const EXTENSION_ID = `${MANIFEST.publisher}.${MANIFEST.name}`;
const TUTORIAL_DIR = path.resolve(__dirname, '../../../examples/tutorial');

/**
 * Removes a test's temporary folder. On Windows the TypeScript server can still be watching it
 * for a moment after its editors close, and the delete fails with EPERM; that is retried, and a
 * folder in the system temp directory left behind is no reason to fail the test.
 */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* left for the system's temp cleanup */
  }
}
const TARQL_DRIFT_DIR = path.resolve(__dirname, '../../../examples/tarql_drift');

suite('Ontology Development Suite (extension host)', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found -- check publisher/name in package.json`);
    await ext!.activate();
  });

  test('activates and registers all contributed commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'ontologySuite.newOntology',
      'ontologySuite.addClass',
      'ontologySuite.addProperty',
      'ontologySuite.openQueryWorkbench',
      'ontologySuite.openGraphView',
      'ontologySuite.runLocalChecks',
      'ontologySuite.showMetrics',
      'ontologySuite.inferFromCsv',
      'ontologySuite.runDeepValidation',
      'ontologySuite.runFullTriplify',
      'ontologySuite.convertFormat',
      'ontologySuite.reviewTarqlBinds',
    ]) {
      assert.ok(commands.includes(id), `command ${id} was not registered`);
    }
  });

  test('Review TARQL BIND Consistency reports TQL findings on examples/tarql_drift', async () => {
    // Folder-scoped rather than document-scoped, so it is invoked with the folder
    // the explorer context menu would pass -- see triplify/tarqlReview.ts.
    const folder = vscode.Uri.file(TARQL_DRIFT_DIR);
    await vscode.commands.executeCommand('ontologySuite.reviewTarqlBinds', folder);

    const lanes = vscode.Uri.file(path.join(TARQL_DRIFT_DIR, 'lanes_to_rdf.rq'));
    const roads = vscode.Uri.file(path.join(TARQL_DRIFT_DIR, 'roads_to_rdf.rq'));
    let codes: (string | number | undefined)[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      codes = [...vscode.languages.getDiagnostics(lanes), ...vscode.languages.getDiagnostics(roads)]
        .map((d) => (typeof d.code === 'object' ? d.code.value : d.code));
      if (codes.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // The fixture seeds exactly one of each: ?road_IRI minted two ways across the
    // pair (TQL-001, reported on both competing BINDs), ?direction_IRI never bound
    // (TQL-002), and ?roadname, which is a CSV column (TQL-003).
    assert.ok(codes.includes('TQL-001'), `expected a TQL-001 finding, got ${JSON.stringify(codes)}`);
    assert.ok(codes.includes('TQL-002'), `expected a TQL-002 finding, got ${JSON.stringify(codes)}`);
    assert.ok(codes.includes('TQL-003'), `expected a TQL-003 finding, got ${JSON.stringify(codes)}`);
  }).timeout(30000);

  test('opening clinic.ttl assigns the turtle language', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(TUTORIAL_DIR, 'clinic.ttl'));
    assert.strictEqual(doc.languageId, 'turtle');
  });

  test('Run Local Checks against clinic.ttl populates the Problems panel with real findings', async () => {
    const uri = vscode.Uri.file(path.join(TUTORIAL_DIR, 'clinic.ttl'));
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand('ontologySuite.runLocalChecks');

    // Local checks run async work (holosdb, shacl-wasm, EYE); poll briefly for diagnostics
    // to land rather than assuming they're synchronous by the time the command resolves.
    let diagnostics: vscode.Diagnostic[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      diagnostics = vscode.languages.getDiagnostics(uri);
      if (diagnostics.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(diagnostics.length > 0, 'expected at least one diagnostic after Run Local Checks');
    // The MDL-001 guidance finding (see checks/modellingGuidance.test.ts) should be among them.
    assert.ok(diagnostics.some((d) => d.code === 'MDL-001'), 'expected an MDL-001 finding among the diagnostics');
  }).timeout(30000);

  test('Convert / Save As Serialization unwinds cleanly when its format picker is cancelled', async () => {
    const targetPath = path.join(TUTORIAL_DIR, 'clinic.nt');
    try {
      const uri = vscode.Uri.file(path.join(TUTORIAL_DIR, 'clinic.ttl'));
      await vscode.window.showTextDocument(uri);

      // convertFormat prompts via QuickPick for the target format; the conversion
      // itself is covered in rdf/serialization.test.ts. What is left to check here
      // is that the command is wired up, unwinds cleanly when cancelled, and writes
      // nothing on the way out.
      //
      // The original version simply awaited the command, on the stated assumption
      // that "QuickPick cancels immediately with no UI interaction available in a
      // headless test run". It does not: `vscode-test` opens a real window, the
      // picker stays up, and the command never resolves. That went unnoticed
      // because the suite's EXTENSION_ID was wrong, so no test in this file ran.
      const invocation = vscode.commands.executeCommand('ontologySuite.convertFormat');
      let settled = false;
      void invocation.then(() => { settled = true; }, () => { settled = true; });
      for (let attempt = 0; attempt < 20 && !settled; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      }
      await invocation;

      const written = await vscode.workspace.fs.stat(vscode.Uri.file(targetPath)).then(() => true, () => false);
      assert.ok(!written, 'a cancelled Convert / Save As should not write an output file');
    } finally {
      await vscode.workspace.fs.delete(vscode.Uri.file(targetPath), { useTrash: false }).then(
        () => undefined,
        () => undefined,
      );
    }
  });

  test('Run Ontology Script runs the script as it stands in the editor, unsaved edits included', async () => {
    // Until 0.13.13 the command read the file from disk, so an unsaved edit was not run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-suite-run-'));
    const scriptUri = vscode.Uri.file(path.join(dir, 'unsaved.ontology.ts'));
    fs.writeFileSync(scriptUri.fsPath, "import { ontology, defclass } from 'ontology-suite/dsl';\nontology('http://example.org/t#', 't');\n");
    try {
      const editor = await vscode.window.showTextDocument(scriptUri);
      await editor.edit((edit) => edit.insert(new vscode.Position(2, 0), "defclass('OnlyInTheEditor');\n"));
      assert.ok(editor.document.isDirty, 'the edit should be unsaved');

      await vscode.commands.executeCommand('ontologySuite.runOntologyScript');

      // No unsaved.ttl yet, so the command writes one rather than asking how to apply the output.
      const turtle = fs.readFileSync(path.join(dir, 'unsaved.ttl'), 'utf8');
      assert.match(turtle, /OnlyInTheEditor/);
    } finally {
      await vscode.window.showTextDocument(scriptUri);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      removeTempDir(dir);
    }
  }).timeout(60000);

  test("the editor types a script through the extension's TypeScript plugin, and marks an mx syntax error", async () => {
    // The plugin is tested against tsserver directly (scripting/tsPlugin.test.ts); this is VS Code
    // itself loading it from typescriptServerPlugins, for a file outside any tsconfig.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-suite-types-'));
    const uri = vscode.Uri.file(path.join(dir, 'typo.ontology.ts'));
    fs.writeFileSync(uri.fsPath, "import { ontology, mx } from 'ontology-suite/dsl';\nontology('http://example.org/t#', 't');\nexport const fish = mx`livesIn soem Aquarium`;\n");
    try {
      await vscode.window.showTextDocument(uri);
      // The TypeScript server starts on first use, which can take a while.
      let diagnostics: vscode.Diagnostic[] = [];
      for (let attempt = 0; attempt < 120; attempt++) {
        diagnostics = vscode.languages.getDiagnostics(uri);
        if (diagnostics.some((d) => d.message.startsWith('Manchester syntax'))) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.deepStrictEqual(
        diagnostics.map((d) => [d.message, d.range.start.line, d.range.start.character, d.range.end.character]),
        [["Manchester syntax: Unexpected 'soem' after a complete class expression.", 2, 31, 35]],
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      removeTempDir(dir);
    }
  }).timeout(90000);
});
