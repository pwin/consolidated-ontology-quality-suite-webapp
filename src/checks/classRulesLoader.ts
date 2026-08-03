import * as vscode from 'vscode';
import { ClassRulesConfig, EMPTY_CLASS_RULES } from './classRules';

const CONFIG_SECTION = 'ontologySuite';
const CONFIG_KEY = 'projectRulesPath';
const DEFAULT_PATH = '.ontology-suite/class-rules.json';

/**
 * Loads the project's `.ontology-suite/class-rules.json` (path configurable
 * via `ontologySuite.projectRulesPath`). Missing file or invalid JSON both
 * resolve to no rules -- this is opt-in project configuration, not a
 * required file.
 */
export async function loadClassRulesConfig(): Promise<ClassRulesConfig> {
  const relativePath = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY, DEFAULT_PATH);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return EMPTY_CLASS_RULES;

  const uri = vscode.Uri.joinPath(folder.uri, relativePath);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Partial<ClassRulesConfig>;
    return { rules: Array.isArray(parsed.rules) ? parsed.rules : [] };
  } catch {
    return EMPTY_CLASS_RULES;
  }
}
