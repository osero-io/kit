import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/packages/client-fork',
  test: {
    name: '@osero/client:fork',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['fork/**/*.test.ts'],
    // Every fork file shares one Anvil node and some revert snapshots, so they must not interleave.
    fileParallelism: false,
    reporters: ['default'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
