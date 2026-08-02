import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { runModellingGuidance } from './modellingGuidance';

const EX = 'http://example.org/clinic#';

describe('runModellingGuidance against examples/tutorial/clinic.ttl', () => {
  it('flags all three deliberately-planted MDL smells', async () => {
    const dir = path.resolve(__dirname, '../../examples/tutorial');
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads } = await resolveImports(clinicPath, clinicDoc.quads, dir);

    const rows = runModellingGuidance(mergedQuads);
    const byCheckAndFocus = rows.map((r) => `${r.checkId}@${r.focusNode}`);

    // MDL-001: ex:isOwnerOf declared as a top-level owl:inverseOf ex:hasOwner.
    expect(byCheckAndFocus).toContain(`MDL-001@${EX}isOwnerOf`);
    // MDL-002: ex:Veterinarian owl:equivalentClass ex:AnimalDoctor (named-to-named, no definition).
    expect(byCheckAndFocus).toContain(`MDL-002@${EX}Veterinarian`);
    // MDL-003: ex:AppointmentType has no structure of its own.
    expect(byCheckAndFocus).toContain(`MDL-003@${EX}AppointmentType`);

    // All modelling guidance is advisory (Hint), never Violation/Warning.
    expect(rows.every((r) => r.severity === 'Hint')).toBe(true);
  });
});
