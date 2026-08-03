import * as vscode from 'vscode';
import { DEFAULT_PROJECT_STANDARDS, ProjectStandards } from './projectStandardsCore';

export { ProjectStandards, DEFAULT_PROJECT_STANDARDS, resolveStandardsIris } from './projectStandardsCore';

const CONFIG_SECTION = 'ontologySuite';
const CONFIG_KEY = 'projectStandardsPath';
const DEFAULT_PATH = '.ontology-suite/standards.json';

/**
 * Loads `.ontology-suite/standards.json` from the workspace root (path
 * configurable via `ontologySuite.projectStandardsPath`); every field has a
 * built-in default, so a project need only override what it cares about.
 */
export async function loadProjectStandards(): Promise<ProjectStandards> {
  const relativePath = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY, DEFAULT_PATH);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return DEFAULT_PROJECT_STANDARDS;

  const uri = vscode.Uri.joinPath(folder.uri, relativePath);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const overrides = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Partial<ProjectStandards>;
    return { ...DEFAULT_PROJECT_STANDARDS, ...overrides, prefixes: { ...DEFAULT_PROJECT_STANDARDS.prefixes, ...overrides.prefixes } };
  } catch {
    return DEFAULT_PROJECT_STANDARDS; // no project-local file -- built-in defaults apply, not an error
  }
}
