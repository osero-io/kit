import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/client',
  test: {
    name: '@osero/client',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/_testing.ts'],
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80,
        // Wallet adapters move funds, so each one carries its own floor instead
        // of hiding behind the package average. Floors sit just below what the
        // suite reaches; raise them with coverage, never lower them to pass.
        'src/viem.ts': { statements: 90, branches: 87, functions: 92, lines: 90 },
        'src/ethers.ts': { statements: 85, branches: 80, functions: 85, lines: 87 },
        'src/privy.ts': { statements: 85, branches: 75, functions: 95, lines: 84 },
        'src/eip5792.ts': { statements: 92, branches: 85, functions: 95, lines: 91 },
        'src/lib/adapters.ts': { statements: 89, branches: 85, functions: 95, lines: 91 },
      },
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
