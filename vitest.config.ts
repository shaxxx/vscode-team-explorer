import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // `vscode` exists only inside the extension host, so importing it in a
      // test throws and the whole command layer was untestable. This stand-in
      // records what the extension showed and lets a test drive a command.
      vscode: fileURLToPath(new URL('./test/vscode-mock.ts', import.meta.url)),
    },
  },
});
