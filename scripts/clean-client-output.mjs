import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

await Promise.all([
  rm(new URL('../packages/client/dist', import.meta.url), { force: true, recursive: true }),
  rm(new URL('../packages/client/out-tsc', import.meta.url), { force: true, recursive: true }),
  rm(new URL('../tsconfig.tsbuildinfo', import.meta.url), { force: true }),
]);

console.log(`Cleaned generated client outputs under ${workspaceRoot}`);
