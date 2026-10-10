/**
 * TypeScript server plugin that types a user's `.ontology.ts` script. Run Ontology Script
 * supplies `ontology-suite/dsl` only at run time (scriptRunnerEntry.ts patches Node's resolver),
 * so the editor's TypeScript service can't find the module: every script would show "Cannot
 * find module 'ontology-suite/dsl'", and the DSL would be typed as `any`.
 *
 * package.json's `typescriptServerPlugins` has VS Code load this into its TypeScript server for
 * every workspace, whether or not this extension has activated, so it keeps to two things:
 *
 * - When TypeScript fails to resolve `ontology-suite/dsl`, it resolves it to the declarations
 *   ts-plugin-build.js generates into dist/dsl-types. Every other import, and an
 *   `ontology-suite/dsl` that TypeScript did resolve (a tsconfig `paths` entry, say), is left as
 *   TypeScript found it.
 * - In a file that imports the DSL, it reports a Manchester syntax error inside an `mx` template
 *   where it is, rather than leaving it to surface when the script runs.
 */
import * as path from 'node:path';
import type * as ts from 'typescript';
import { ClassExpressionSyntaxError, parseClassExpressionStrict } from '../rdf/formats/classExpressionParser';

type TypeScript = typeof ts;

const SPECIFIER = 'ontology-suite/dsl';

/** This plugin's own diagnostic code, clear of TypeScript's (which run to the 18000s). */
export const MX_SYNTAX_ERROR = 98001;

/** `dslTypes` is the declaration file to resolve `ontology-suite/dsl` to. */
export function createPlugin(dslTypes: string): ts.server.PluginModuleFactory {
  return ({ typescript }) => ({
    create(info) {
      const host = info.languageServiceHost;
      // tsserver's host has implemented this since TypeScript 5.0. With an older workspace
      // TypeScript, `ontology-suite/dsl` stays unresolved.
      const resolve = host.resolveModuleNameLiterals?.bind(host);
      if (resolve) {
        const dsl: ts.ResolvedModuleFull = { resolvedFileName: dslTypes, extension: typescript.Extension.Dts, isExternalLibraryImport: true };
        host.resolveModuleNameLiterals = (literals, ...rest) =>
          resolve(literals, ...rest).map((r, i) => (r.resolvedModule || literals[i].text !== SPECIFIER ? r : { ...r, resolvedModule: dsl }));
      }
      return withMxDiagnostics(typescript, info.languageService);
    },
  });
}

/** `service`, with an error added for each `mx` template whose Manchester text doesn't parse. */
function withMxDiagnostics(typescript: TypeScript, service: ts.LanguageService): ts.LanguageService {
  const proxy = Object.create(null) as Record<string, unknown>;
  for (const [name, member] of Object.entries(service)) proxy[name] = typeof member === 'function' ? member.bind(service) : member;
  const withMx = proxy as unknown as ts.LanguageService;
  withMx.getSemanticDiagnostics = (fileName) => {
    const diagnostics = service.getSemanticDiagnostics(fileName);
    try {
      return [...diagnostics, ...mxDiagnostics(typescript, service, fileName)];
    } catch {
      // This check must never cost the file its other diagnostics.
      return diagnostics;
    }
  };
  return withMx;
}

function mxDiagnostics(typescript: TypeScript, service: ts.LanguageService, fileName: string): ts.Diagnostic[] {
  const program = service.getProgram();
  const file = program?.getSourceFile(fileName);
  if (!program || !file || !file.text.includes(SPECIFIER)) return [];
  const checker = program.getTypeChecker();
  const found: ts.Diagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (typescript.isTaggedTemplateExpression(node) && isDslMx(typescript, checker, node.tag)) {
      const error = checkMx(typescript, checker, node.template);
      if (error) found.push({ file, ...error, category: typescript.DiagnosticCategory.Error, code: MX_SYNTAX_ERROR, source: 'ontology-suite' });
    }
    typescript.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether `tag` is the DSL's `mx`: imported by name, renamed or not, or used through a namespace import. */
function isDslMx(typescript: TypeScript, checker: ts.TypeChecker, tag: ts.Expression): boolean {
  const fromDsl = (declaration: ts.Node): boolean => {
    let node: ts.Node | undefined = declaration;
    while (node && !typescript.isImportDeclaration(node)) node = node.parent;
    return !!node && typescript.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === SPECIFIER;
  };
  if (typescript.isIdentifier(tag)) {
    const declaration = checker.getSymbolAtLocation(tag)?.declarations?.[0];
    return !!declaration && typescript.isImportSpecifier(declaration) && (declaration.propertyName ?? declaration.name).text === 'mx' && fromDsl(declaration);
  }
  if (typescript.isPropertyAccessExpression(tag) && tag.name.text === 'mx') {
    const declaration = checker.getSymbolAtLocation(tag.expression)?.declarations?.[0];
    return !!declaration && typescript.isNamespaceImport(declaration) && fromDsl(declaration);
  }
  return false;
}

/**
 * Parses an `mx` template as mx will at run time, with each `${...}` standing as a token of the
 * kind it holds: a number, a string, or an IRI for anything else (a class, a property, a class
 * expression). Returns the first syntax error, placed in the file.
 */
function checkMx(typescript: TypeScript, checker: ts.TypeChecker, template: ts.TemplateLiteral): { start: number; length: number; messageText: string } | undefined {
  // Each piece of the parsed text, and where it came from: a literal part from just after its
  // opening backtick or `}`, character for character; a substitution from its expression.
  const pieces: { at: number; text: string; start: number; width?: number }[] = [];
  let text = '';
  const add = (piece: string, start: number, width?: number) => {
    pieces.push({ at: text.length, text: piece, start, width });
    text += piece;
  };
  if (typescript.isNoSubstitutionTemplateLiteral(template)) {
    add(template.text, template.getStart() + 1);
  } else {
    add(template.head.text, template.head.getStart() + 1);
    for (const span of template.templateSpans) {
      const flags = checker.getTypeAtLocation(span.expression).flags;
      const token = flags & typescript.TypeFlags.NumberLike ? '0' : flags & typescript.TypeFlags.StringLike ? '""' : '<urn:x>';
      add(token, span.expression.getStart(), span.expression.getWidth());
      add(span.literal.text, span.literal.getStart() + 1);
    }
  }

  try {
    parseClassExpressionStrict(text);
    return undefined;
  } catch (err) {
    if (!(err instanceof ClassExpressionSyntaxError)) throw err;
    const messageText = `Manchester syntax: ${err.message}`;
    const piece = pieces.find((p) => err.offset >= p.at && err.offset < p.at + p.text.length);
    if (!piece) {
      // At the end of the text: mark the closing backtick.
      const last = pieces[pieces.length - 1];
      return { start: last.start + last.text.length, length: 1, messageText };
    }
    if (piece.width !== undefined) return { start: piece.start, length: piece.width, messageText };
    const into = err.offset - piece.at;
    return { start: piece.start + into, length: Math.max(1, Math.min(err.length, piece.text.length - into)), messageText };
  }
}

// tsserver calls the plugin package's export with `{ typescript }`; the package
// ts-plugin-build.js writes into node_modules re-exports this.
export const init = createPlugin(path.join(__dirname, 'dsl-types', 'scripting', 'dsl.d.ts'));
