import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // src/test/integration/** are @vscode/test-cli tests (`npm run test:integration`):
    // they import 'vscode', which only resolves inside a real extension host, not plain Node.
    exclude: ['src/test/integration/**', 'node_modules/**'],
    // shacl-engine/reasoning tests pay a one-time Comunica/EYE module-load
    // cost (several seconds) the first time they run in the process.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
