import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/migration-rehearsal.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  external: ['pg-native'],
});
console.log('dist/migration-rehearsal.mjs');
