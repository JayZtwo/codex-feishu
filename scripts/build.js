import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    '@larksuiteoapi/node-sdk',
    'markdown-it',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});

console.log('Built dist/daemon.mjs');
