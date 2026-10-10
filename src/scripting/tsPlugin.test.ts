import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const pluginBuild = require(path.join(root, 'ts-plugin-build.js')) as {
  PLUGIN_NAME: string;
  writeDslTypes: (outDir: string) => void;
  writePluginShim: (extensionRoot: string) => void;
};

/** tsserver, driven over its JSON protocol the way VS Code drives it. */
class TsServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (response: any) => void>();
  private seq = 0;
  private buffer = Buffer.alloc(0);

  constructor(args: string[]) {
    this.child = spawn(process.execPath, [path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'), ...args]);
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
  }

  /** For commands tsserver doesn't answer, such as `open`. */
  send(command: string, args: object): number {
    const seq = ++this.seq;
    this.child.stdin.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`);
    return seq;
  }

  request(command: string, args: object): Promise<any> {
    const seq = this.send(command, args);
    return new Promise((resolve) => this.pending.set(seq, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill();
    });
  }

  // Each message arrives as `Content-Length: <bytes>\r\n\r\n<json>`.
  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]);
      const end = headerEnd + 4 + length;
      if (this.buffer.length < end) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, end).toString('utf8'));
      this.buffer = this.buffer.subarray(end);
      if (message.type === 'response') this.pending.get(message.request_seq)?.(message);
    }
  }
}

/** A diagnostic as tsserver reports it: lines and offsets count from 1. */
type Found = { code: number; text: string; start: { line: number; offset: number }; end: { line: number; offset: number } };

describe('TypeScript plugin for ontology-suite/dsl', () => {
  // A stand-in for the installed extension (dist/, and the plugin's package in node_modules), and
  // beside it a folder of scripts with no tsconfig, which is what a user's usually is.
  let tmp: string;
  let extension: string;
  let workspace: string;
  let server: TsServer;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-suite-ts-plugin-'));
    extension = path.join(tmp, 'extension');
    workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace);
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'tsPlugin.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      outfile: path.join(extension, 'dist', 'tsPlugin.js'),
      logLevel: 'silent',
    });
    pluginBuild.writeDslTypes(path.join(extension, 'dist', 'dsl-types'));
    pluginBuild.writePluginShim(extension);

    // The arguments VS Code starts tsserver with for an extension's `typescriptServerPlugins`.
    server = new TsServer(['--globalPlugins', pluginBuild.PLUGIN_NAME, '--pluginProbeLocations', extension, '--disableAutomaticTypingAcquisition', '--locale', 'en']);
    // Close to VS Code's defaults for a file outside any tsconfig.
    await server.request('compilerOptionsForInferredProjects', { options: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022', strict: true } });
  });

  afterAll(async () => {
    await server?.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  function open(name: string, text: string): string {
    const file = path.join(workspace, name);
    server.send('open', { file, fileContent: text, scriptKindName: 'TS', projectRootPath: workspace });
    return file;
  }

  async function errors(name: string, text: string): Promise<Found[]> {
    const file = open(name, text);
    return (await server.request('semanticDiagnosticsSync', { file })).body;
  }

  it("is the name package.json's typescriptServerPlugins gives VS Code", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.contributes.typescriptServerPlugins.map((p: { name: string }) => p.name)).toEqual([pluginBuild.PLUGIN_NAME]);
  });

  it("types the tutorial's advanced example with no errors", async () => {
    const example = fs.readFileSync(path.join(root, 'examples', 'scripting', 'pets-advanced.ontology.ts'), 'utf8');
    expect(await errors('pets-advanced.ontology.ts', example)).toEqual([]);
  });

  it('catches a misspelt option', async () => {
    const script = ["import { defclass } from 'ontology-suite/dsl';", "const A = defclass('A');", "defclass('B', { subClassOff: [A] });"].join('\n');
    const found = await errors('typo.ontology.ts', script);
    expect(found.map((d) => d.code)).toEqual([2561]);
    expect(found[0].text).toContain("Did you mean to write 'subClassOf'?");
  });

  it("shows the DSL's signatures on hover", async () => {
    const file = open('hover.ontology.ts', "import { defclass } from 'ontology-suite/dsl';\ndefclass('A');\n");
    const info = await server.request('quickinfo', { file, line: 2, offset: 1 });
    expect(info.body.displayString).toContain('defclass(name: string, opts?: DefClassOptions): ClassRef');
  });

  it("leaves every other import alone, and doesn't make n3's types importable", async () => {
    const script = ["import { defclass } from 'ontology-suite/dsl';", "import { x } from 'no-such-package';", "import type { Quad } from 'n3';"].join('\n');
    const found = await errors('others.ontology.ts', script);
    expect(found.map((d) => [d.code, d.text])).toEqual([
      [2307, "Cannot find module 'no-such-package' or its corresponding type declarations."],
      [2307, "Cannot find module 'n3' or its corresponding type declarations."],
    ]);
  });

  const located = (found: Found[]) => found.map((d) => [d.code, d.text, `${d.start.line}:${d.start.offset}-${d.end.line}:${d.end.offset}`]);

  it('accepts well-formed mx templates, with each kind of substitution', async () => {
    const script = [
      "import { ontology, defclass, defobjectproperty, mx } from 'ontology-suite/dsl';",
      "ontology('http://example.org/zoo#', 'zoo');",
      "const Animal = defclass('Animal');",
      "const hasMember = defobjectproperty('hasMember');",
      "defclass('Herd', { subClassOf: [mx`${hasMember} min ${3} ${Animal}`, mx`livesIn some (Aquarium or Pond)`, mx`{red, green}`] });",
    ].join('\n');
    expect(await errors('mx-ok.ontology.ts', script)).toEqual([]);
  });

  it('marks a Manchester syntax error in an mx template where it is', async () => {
    const script = ["import { mx } from 'ontology-suite/dsl';", 'const e = mx`livesIn soem Aquarium`;'].join('\n');
    expect(located(await errors('mx-word.ontology.ts', script))).toEqual([
      [98001, "Manchester syntax: Unexpected 'soem' after a complete class expression.", '2:22-2:26'],
    ]);
  });

  it('marks the closing backtick when the expression stops short, and a substitution when it is the wrong kind', async () => {
    const script = [
      "import { defobjectproperty, mx } from 'ontology-suite/dsl';",
      "const p = defobjectproperty('p');",
      'const short = mx`livesIn some`;',
      "const wrong = mx`${p} min ${'x'} Animal`;",
    ].join('\n');
    expect(located(await errors('mx-places.ontology.ts', script))).toEqual([
      [98001, 'Manchester syntax: Unexpected end of class expression.', '3:30-3:31'],
      [98001, "Manchester syntax: Expected a whole number after 'min'.", '4:29-4:32'],
    ]);
  });

  it("checks the DSL's mx however it is imported, and no other function called mx", async () => {
    const script = [
      "import { mx as manchester } from 'ontology-suite/dsl';",
      "import * as dsl from 'ontology-suite/dsl';",
      'function mx(s: TemplateStringsArray) { return s; }',
      'manchester`a soem b`;',
      'dsl.mx`a soem b`;',
      'mx`a soem b`;',
    ].join('\n');
    expect(located(await errors('mx-imports.ontology.ts', script)).map(([, , at]) => at)).toEqual(['4:14-4:18', '5:10-5:14']);
  });

  it('generates declarations that compile on their own, strict and without skipLibCheck', () => {
    const dsl = path.join(extension, 'dist', 'dsl-types', 'scripting', 'dsl.d.ts');
    const program = ts.createProgram([dsl], {
      strict: true,
      noEmit: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });
});
