import * as vscode from 'vscode';

const WELL_KNOWN_IMPORTS: { label: string; iri: string; description: string }[] = [
  { label: 'gist (Semantic Arts)', iri: 'https://w3id.org/semanticarts/ontology/gistCore14.1.0', description: 'minimalist upper ontology' },
  { label: 'schema.org', iri: 'https://schema.org/', description: 'general-purpose schema vocabulary' },
  { label: 'SKOS', iri: 'http://www.w3.org/2004/02/skos/core#', description: 'taxonomies / controlled vocabularies' },
  { label: 'Dublin Core Terms', iri: 'http://purl.org/dc/terms/', description: 'metadata terms' },
  { label: 'PROV-O', iri: 'http://www.w3.org/ns/prov#', description: 'provenance' },
];

export async function newOntologyWizard(): Promise<{ uri: vscode.Uri; content: string } | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('Open a folder/workspace first.');
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Ontology name (PascalCase, used for the file name and prefix)',
    placeHolder: 'MyOntology',
    validateInput: (v) => (/^[A-Za-z][A-Za-z0-9]*$/.test(v) ? undefined : 'Use a simple PascalCase identifier'),
  });
  if (!name) return undefined;

  const baseIri = await vscode.window.showInputBox({
    prompt: 'Base namespace IRI',
    value: `http://example.org/${name.toLowerCase()}#`,
  });
  if (!baseIri) return undefined;

  const prefix = await vscode.window.showInputBox({
    prompt: 'Preferred prefix for this namespace',
    value: name.toLowerCase(),
    validateInput: (v) => (/^[a-z][a-z0-9-]*$/.test(v) ? undefined : 'lowercase, starting with a letter'),
  });
  if (!prefix) return undefined;

  const importPicks = await vscode.window.showQuickPick(
    WELL_KNOWN_IMPORTS.map((i) => ({ label: i.label, description: i.description, detail: i.iri, iri: i.iri })),
    { canPickMany: true, placeHolder: 'Select any ontologies to owl:import (optional)' },
  );

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `@prefix ${prefix}: <${baseIri}> .`,
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${baseIri.replace(/[#/]$/, '')}>`,
    '  a owl:Ontology ;',
    `  owl:versionInfo "0.1.0" ;`,
    `  skos:prefLabel "${name}"^^xsd:string ;`,
    `  rdfs:comment "Created ${today}."^^xsd:string ;`,
  ];
  for (const pick of importPicks ?? []) {
    lines.push(`  owl:imports <${(pick as { iri: string }).iri}> ;`);
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/;\s*$/, '.');
  lines.push('');

  const fileName = `${name}.ttl`;
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
  return { uri, content: lines.join('\n') };
}

export interface AddClassOptions {
  className: string;
  label: string;
  asCategory: boolean;
  prefix: string;
}

/** "Add Class or Category" -- see MDL-003: a plain classification/tag should usually be a gist:Category, not a new owl:Class. */
export async function promptAddClass(prefix: string): Promise<AddClassOptions | undefined> {
  const className = await vscode.window.showInputBox({
    prompt: 'Class or Category name (PascalCase)',
    validateInput: (v) => (/^[A-Za-z][A-Za-z0-9]*$/.test(v) ? undefined : 'Use PascalCase'),
  });
  if (!className) return undefined;

  const label = (await vscode.window.showInputBox({ prompt: 'Label', value: humanize(className) })) ?? humanize(className);

  const kind = await vscode.window.showQuickPick(
    [
      { label: 'Class', description: 'has its own structure/relationships (owl:Class)', asCategory: false },
      { label: 'Category', description: "classification/tag only, no independent structure (see MDL-003)", asCategory: true },
    ],
    { placeHolder: 'Does this term need its own structure/relationships, or is it just a classification?' },
  );
  if (!kind) return undefined;

  return { className, label, asCategory: kind.asCategory, prefix };
}

export function renderAddClassTurtle(opts: AddClassOptions): string {
  if (opts.asCategory) {
    return [
      '',
      `${opts.prefix}:${opts.className}`,
      '  a gist:Category ;',
      `  rdfs:label "${opts.label}"^^xsd:string ;`,
      '  .',
      '',
    ].join('\n');
  }
  return ['', `${opts.prefix}:${opts.className}`, '  a owl:Class ;', `  rdfs:label "${opts.label}"^^xsd:string ;`, '  .', ''].join('\n');
}

export interface AddPropertyOptions {
  propertyName: string;
  label: string;
  kind: 'ObjectProperty' | 'DatatypeProperty' | 'AnnotationProperty';
  domain?: string;
  range?: string;
  prefix: string;
}

/**
 * Does *not* prompt for/auto-generate a paired inverse property by
 * default -- see MDL-001 / the "Gist-informed modelling guidance" plan
 * section: gist's own convention only scopes owl:inverseOf inline to a
 * single restriction, never as a second top-level named property.
 */
export async function promptAddProperty(prefix: string): Promise<AddPropertyOptions | undefined> {
  const propertyName = await vscode.window.showInputBox({
    prompt: 'Property name (camelCase, conventionally starting with "has")',
    validateInput: (v) => (/^[a-z][A-Za-z0-9]*$/.test(v) ? undefined : 'Use camelCase'),
  });
  if (!propertyName) return undefined;

  const label = (await vscode.window.showInputBox({ prompt: 'Label', value: humanize(propertyName) })) ?? humanize(propertyName);

  const kindPick = await vscode.window.showQuickPick(
    [
      { label: 'ObjectProperty', description: 'relates two individuals' },
      { label: 'DatatypeProperty', description: 'relates an individual to a literal value' },
      { label: 'AnnotationProperty', description: 'metadata, not used in reasoning' },
    ],
    { placeHolder: 'Property kind' },
  );
  if (!kindPick) return undefined;

  const domain = await vscode.window.showInputBox({ prompt: 'Domain class CURIE (optional)', placeHolder: `${prefix}:SomeClass` });
  const range = await vscode.window.showInputBox({ prompt: 'Range class/datatype CURIE (optional)', placeHolder: `${prefix}:SomeClass or xsd:string` });

  return { propertyName, label, kind: kindPick.label as AddPropertyOptions['kind'], domain: domain || undefined, range: range || undefined, prefix };
}

export function renderAddPropertyTurtle(opts: AddPropertyOptions): string {
  const lines = ['', `${opts.prefix}:${opts.propertyName}`, `  a owl:${opts.kind} ;`, `  rdfs:label "${opts.label}"^^xsd:string ;`];
  if (opts.domain) lines.push(`  rdfs:domain ${opts.domain} ;`);
  if (opts.range) lines.push(`  rdfs:range ${opts.range} ;`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/;\s*$/, '.');
  lines.push('');
  return lines.join('\n');
}

function humanize(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
