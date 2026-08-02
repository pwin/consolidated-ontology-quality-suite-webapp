const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const entryDir = path.join(__dirname, 'src', 'test', 'integration');
const entryPoints = fs.readdirSync(entryDir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(entryDir, f));

async function main() {
  await esbuild.build({
    entryPoints,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outdir: 'out/test/integration',
    external: ['vscode', 'mocha'],
    sourcemap: true,
    logLevel: 'info',
  });
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
