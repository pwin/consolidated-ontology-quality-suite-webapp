import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(__dirname, '../..');
const npmPackage = require(path.join(root, 'npm-package.js')) as {
  NAME: string;
  REQUIRED: string[];
  buildNpmPackage: (outDir: string) => string;
  packedFiles: (dir: string) => string[];
};

function run(command: string, args: string[], cwd: string): { status: number | null; out: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && command === 'npm' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const tsc = (cwd: string, project: string) => run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', project], cwd);

/**
 * The package as someone else gets it: built, packed into a tarball, and installed from that
 * tarball into an otherwise empty project.
 */
describe('the ontology-suite npm package', () => {
  let tmp: string;
  let pkg: string;
  let consumer: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-suite-npm-'));
    pkg = npmPackage.buildNpmPackage(path.join(tmp, npmPackage.NAME));
    const packed = run('npm', ['pack', '--json', '--pack-destination', tmp], pkg);
    expect(packed.status, packed.out).toBe(0);
    const tarball = path.join(tmp, JSON.parse(packed.out.slice(packed.out.indexOf('[')))[0].filename);
    consumer = path.join(tmp, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
    const installed = run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', tarball], consumer);
    expect(installed.status, installed.out).toBe(0);
  }, 120000);

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  it('holds what it needs and nothing of the extension', () => {
    const files = npmPackage.packedFiles(pkg);
    expect(files).toEqual(expect.arrayContaining(npmPackage.REQUIRED));
    expect(files.filter((f) => !/^(package\.json|README\.md|LICENSE|dsl\/.*)$/.test(f))).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    expect(manifest.version).toBe(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    expect(manifest.dependencies).toBeUndefined();
  });

  it('loads with require and with import, and builds an ontology', () => {
    const script = "ontology('http://example.org/zoo#', 'zoo'); defclass('Animal'); console.log(build().quads.length);";
    const required = run(process.execPath, ['-e', `const { ontology, defclass, build } = require('ontology-suite/dsl'); ${script}`], consumer);
    expect(required.out.trim()).toBe('1');
    const imported = run(process.execPath, ['--input-type=module', '-e', `import { ontology, defclass, build } from 'ontology-suite/dsl'; ${script}`], consumer);
    expect(imported.out.trim()).toBe('1');
  });

  // The README's example and the repo's fullest example, type-checked against the installed
  // package, strict and without skipLibCheck, under each way TypeScript resolves a module.
  it.each([
    ['node16', { module: 'node16', moduleResolution: 'node16' }],
    ['bundler', { module: 'esnext', moduleResolution: 'bundler' }],
    ['node10', { module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0' }],
  ])('type-checks the README and zoo examples under %s resolution', (mode, options) => {
    const readme = fs.readFileSync(path.join(pkg, 'README.md'), 'utf8');
    fs.writeFileSync(path.join(consumer, 'readme.ts'), /```typescript\n([\s\S]*?)```/.exec(readme)![1]);
    fs.copyFileSync(path.join(root, 'examples', 'scripting', 'zoo.ontology.ts'), path.join(consumer, 'zoo.ts'));
    const project = `tsconfig.${mode}.json`;
    fs.writeFileSync(
      path.join(consumer, project),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], target: 'es2022', ...options }, files: ['readme.ts', 'zoo.ts'] }),
    );
    const checked = tsc(consumer, project);
    expect(checked.out).toBe('');
    expect(checked.status).toBe(0);
  });

  it("runs the README's example under Node", () => {
    const readme = fs.readFileSync(path.join(pkg, 'README.md'), 'utf8');
    const { code } = esbuild.transformSync(/```typescript\n([\s\S]*?)```/.exec(readme)![1], { loader: 'ts', format: 'cjs' });
    fs.writeFileSync(path.join(consumer, 'readme.cjs'), code);
    const ran = run(process.execPath, ['readme.cjs'], consumer);
    expect(ran.status, ran.out).toBe(0);
    expect(ran.out).toMatch(/^\d+ triples\n$/);
  });

  it("reports a fact of the wrong kind from the package's own types", () => {
    fs.writeFileSync(
      path.join(consumer, 'wrong.ts'),
      [
        "import { ontology, defobjectproperty, defindividual } from 'ontology-suite/dsl';",
        "ontology('http://example.org/zoo#', 'zoo');",
        "defindividual('rex', { facts: [[defobjectproperty('hasOwner'), 3]] });",
      ].join('\n'),
    );
    fs.writeFileSync(path.join(consumer, 'tsconfig.wrong.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], module: 'node16', moduleResolution: 'node16' }, files: ['wrong.ts'] }));
    const checked = tsc(consumer, 'tsconfig.wrong.json');
    expect(checked.status).not.toBe(0);
    expect(checked.out).toContain('wrong.ts(3,');
    expect(checked.out).toContain('error TS2322');
  });
});
