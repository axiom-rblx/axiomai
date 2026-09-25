import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
// Explicit allowlist: backend code, training data and secrets never become assets.
const output = resolve('dist');
if (dirname(output) !== resolve(process.cwd())) throw new Error('Unexpected build output path');
await rm(output, { recursive: true, force: true });
await mkdir('dist/assets/fonts', { recursive: true });
for (const path of ['index.html', '404.html', 'content.png', 'icons', 'info', 'status', 'assets']) {
  await cp(path, join('dist', path), { recursive: true });
}
for (const family of ['dm-sans', 'jetbrains-mono', 'manrope']) {
  const file = `${family}-latin-wght-normal.woff2`;
  await copyFile(join(`node_modules/@fontsource-variable/${family}/files`, file), join('dist/assets/fonts', file));
}
console.log('Built Axiom website with self-hosted fonts.');
