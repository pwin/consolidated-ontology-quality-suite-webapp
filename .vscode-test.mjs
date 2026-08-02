import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: 'examples/tutorial',
  mocha: {
    timeout: 30000,
  },
});
