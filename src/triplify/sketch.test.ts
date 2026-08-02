import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sketchQuery } from './sketch';

describe('sketchQuery against examples/tutorial/queries/appointments.rq', () => {
  it('turns every ?variable in the CONSTRUCT template into a :variable entity', () => {
    const queryPath = path.resolve(__dirname, '../../examples/tutorial/queries/appointments.rq');
    const text = fs.readFileSync(queryPath, 'utf8');
    const sketch = sketchQuery(text);

    expect(sketch.prefixes.ex).toBe('http://example.org/clinic#');
    expect(sketch.triples).toContain(':appointment a ex:Appointment');
    expect(sketch.triples).toContain('ex:forAnimal :animalRef');
    expect(sketch.triples).toContain('ex:appointmentNotes :notes');
  });
});
