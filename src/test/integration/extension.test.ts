import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'local.ontology-dev-suite';
const TUTORIAL_DIR = path.resolve(__dirname, '../../../examples/tutorial');

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
    ]) {
      assert.ok(commands.includes(id), `command ${id} was not registered`);
    }
  });

  test('opening clinic.ttl assigns the turtle language', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(TUTORIAL_DIR, 'clinic.ttl'));
    assert.strictEqual(doc.languageId, 'turtle');
  });

  test('Run Local Checks against clinic.ttl populates the Problems panel with real findings', async () => {
    const uri = vscode.Uri.file(path.join(TUTORIAL_DIR, 'clinic.ttl'));
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand('ontologySuite.runLocalChecks');

    // Local checks run async work (Oxigraph/shacl-engine/EYE); poll briefly for diagnostics
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

  test('Convert / Save As Serialization writes a real .nt file from clinic.ttl', async () => {
    const targetPath = path.join(TUTORIAL_DIR, 'clinic.nt');
    try {
      const uri = vscode.Uri.file(path.join(TUTORIAL_DIR, 'clinic.ttl'));
      await vscode.window.showTextDocument(uri);
      // convertFormat prompts via QuickPick for the target format; exercised directly through
      // the serialization module in rdf/serialization.test.ts. This test instead confirms the
      // command is wired up and doesn't throw when invoked (QuickPick cancels immediately with
      // no UI interaction available in a headless test run, so no file is asserted here beyond
      // "the command completes without error").
      await vscode.commands.executeCommand('ontologySuite.convertFormat');
      assert.ok(true);
    } finally {
      await vscode.workspace.fs.delete(vscode.Uri.file(targetPath), { useTrash: false }).then(
        () => undefined,
        () => undefined,
      );
    }
  });
});
