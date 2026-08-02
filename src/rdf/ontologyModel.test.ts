import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from './parseDocument';
import { buildOntologyModel } from './ontologyModel';

const clinicPath = path.resolve(__dirname, '../../examples/tutorial/clinic.ttl');
const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
const model = buildOntologyModel(clinicDoc.quads);

const EX = 'http://example.org/clinic#';

describe('buildOntologyModel against examples/tutorial/clinic.ttl', () => {
  it('parses with zero errors', () => {
    expect(clinicDoc.errors).toEqual([]);
  });

  it('classifies classes, object properties, and datatype properties correctly', () => {
    expect(model.terms.get(`${EX}Dog`)?.kinds).toContain('class');
    expect(model.terms.get(`${EX}hasOwner`)?.kinds).toContain('objectProperty');
    expect(model.terms.get(`${EX}hasAppointmentDate`)?.kinds).toContain('datatypeProperty');
  });

  it('captures rdfs:subClassOf targets', () => {
    expect(model.terms.get(`${EX}Dog`)?.subClassOf).toContain(`${EX}Mammal`);
    expect(model.terms.get(`${EX}Cat`)?.subClassOf).toContain(`${EX}Mammal`);
  });

  it('captures rdfs:domain/range on properties', () => {
    const hasOwner = model.terms.get(`${EX}hasOwner`)!;
    expect(hasOwner.domain).toContain(`${EX}Animal`);
    expect(hasOwner.range).toContain(`${EX}Owner`);
  });

  it('captures owl:equivalentClass (named-to-named, the MDL-002 smell)', () => {
    expect(model.terms.get(`${EX}Veterinarian`)?.equivalentClass).toContain(`${EX}AnimalDoctor`);
  });

  it('captures owl:inverseOf on a top-level named property (the MDL-001 smell)', () => {
    expect(model.terms.get(`${EX}isOwnerOf`)?.inverseOf).toContain(`${EX}hasOwner`);
  });

  it('flags AppointmentType as having no structure of its own (the MDL-003 smell)', () => {
    const appointmentType = model.terms.get(`${EX}AppointmentType`)!;
    expect(appointmentType.hasOwnStructure).toBe(false);
    expect(appointmentType.subClassOf).toHaveLength(0);
  });

  it('captures rdfs:label for hover/completion display', () => {
    expect(model.terms.get(`${EX}Dog`)?.label).toBe('Dog');
  });
});
