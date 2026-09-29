import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  // Stamped into the activation banner. Two acceptance failures in a row were
  // ambiguous because there was no way to tell from the log whether the host
  // window was running the build that contained the fix.
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString()),
  },
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching...');
} else {
  await build(options);
}
