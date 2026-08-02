import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { checkUndeclaredTerms } from './prefixAlignment';

describe('checkUndeclaredTerms: appointments.rq against clinic.ttl', () => {
  it('flags ex:appointmentNotes as an undeclared property (deliberately not in clinic.ttl)', async () => {
    const dir = path.resolve(__dirname, '../../examples/tutorial');
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads } = await resolveImports(clinicPath, clinicDoc.quads, dir);

    const queryText = fs.readFileSync(path.join(dir, 'queries/appointments.rq'), 'utf8');
    const undeclared = checkUndeclaredTerms(queryText, mergedQuads);

    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toMatchObject({ kind: 'property', term: 'http://example.org/clinic#appointmentNotes' });
  });

  it('finds no undeclared terms for a query that only uses declared vocabulary', async () => {
    const dir = path.resolve(__dirname, '../../examples/tutorial');
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads } = await resolveImports(clinicPath, clinicDoc.quads, dir);

    const cleanQuery = `
      PREFIX ex: <http://example.org/clinic#>
      CONSTRUCT { ?a a ex:Appointment ; ex:hasAppointmentDate ?d . }
      WHERE { BIND(IRI(CONCAT("http://example.org/clinic#a-", ?id)) AS ?a) }
    `;
    expect(checkUndeclaredTerms(cleanQuery, mergedQuads)).toEqual([]);
  });
});
