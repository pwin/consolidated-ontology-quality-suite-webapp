import * as assert from 'node:assert';
import * as fs from 'node:fs';
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
});
