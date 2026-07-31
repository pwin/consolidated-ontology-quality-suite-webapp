import type { Quad } from 'n3';
import { analyzeExpressivity } from '../rdf/expressivity';
import { computeMetrics } from '../rdf/metrics';

const PROFILE_NOTE =
  'Exceeding a profile is an expressivity fact, not a defect -- develop in EL/QL/RL deliberately for tractable reasoning, or in full OWL2 DL when you need the extra expressivity. This is a heuristic, syntactic indicator, not a certified OWL2 conformance result.';

/**
 * Renders metrics + DL expressivity + OWL2 EL/QL/RL profile membership as
 * Markdown, opened via VS Code's built-in Markdown preview -- "base
 * everything on OWL2 DL, but allow development in the OWL2 profiles": the
 * ontology is never restricted to a profile, this just shows where it
 * currently sits relative to each one.
 */
export function renderMetricsMarkdown(ontologyIri: string | null, quads: Quad[]): string {
  const m = computeMetrics(quads);
  const e = analyzeExpressivity(quads);

  const profileBadge = (p: 'EL' | 'QL' | 'RL') => (e.profileMembership[p] ? `✅ ${p}` : `❌ ${p}`);

  const lines: string[] = [
    `# Ontology Metrics${ontologyIri ? `: ${ontologyIri}` : ''}`,
    '',
    `**DL expressivity:** \`${e.dlExpressivity}\`  `,
    `**OWL2 profile membership:** ${profileBadge('EL')}&nbsp;&nbsp;${profileBadge('QL')}&nbsp;&nbsp;${profileBadge('RL')}`,
    '',
    `> ${PROFILE_NOTE}`,
    '',
    '## Schema metrics',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Classes | ${m.classCount} |`,
    `| Object properties | ${m.objectPropertyCount} |`,
    `| Datatype properties | ${m.datatypePropertyCount} |`,
    `| Annotation properties | ${m.annotationPropertyCount} |`,
    `| Individuals | ${m.individualCount} |`,
    `| Axioms (triples) | ${m.axiomCount} |`,
    `| subClassOf edges | ${m.subClassOfEdgeCount} |`,
    `| Max class-hierarchy depth | ${m.maxDepth} |`,
    `| Inheritance richness | ${m.inheritanceRichness} |`,
    `| Relationship richness | ${m.relationshipRichness} |`,
    `| Attribute richness | ${m.attributeRichness} |`,
    `| Classes with no rdfs:label | ${m.classesWithNoLabel} |`,
    `| Classes with no definition/comment | ${m.classesWithNoDefinition} |`,
    '',
  ];

  if (e.profileViolations.length > 0) {
    lines.push('## Constructs used beyond a profile', '');
    for (const p of ['EL', 'QL', 'RL'] as const) {
      const forProfile = e.profileViolations.filter((v) => v.profile === p);
      if (forProfile.length === 0) continue;
      lines.push(`**Beyond ${p}:** ${Array.from(new Set(forProfile.map((v) => v.construct))).join(', ')}`, '');
    }
  }

  return lines.join('\n');
}
