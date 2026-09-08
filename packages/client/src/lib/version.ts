/**
 * Published SDK version. Kept in sync with `package.json` by
 * `scripts/sync-client-version.mjs`, which runs as part of `pnpm version-packages`;
 * `version.test.ts` fails when the two drift.
 *
 * Annotated as `string` on purpose: without it TypeScript emits the version as a
 * literal type in `dist/lib/version.d.ts`, so every release would change a public
 * declaration hash and trip the `api-report.json` gate.
 */
export const SDK_VERSION: string = '1.0.0-next.5';
