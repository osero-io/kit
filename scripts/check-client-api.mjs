import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRootUrl = new URL('../packages/client/', import.meta.url);
const distUrl = new URL('dist/', packageRootUrl);
const reportUrl = new URL('api-report.json', packageRootUrl);
const expectedEntrypoints = {
  '.': './dist/index.d.ts',
  './actions': './dist/lib/actions/index.d.ts',
  './api': './dist/api.d.ts',
  './contracts': './dist/contracts.d.ts',
  './ethers': './dist/ethers.d.ts',
  './privy': './dist/privy.d.ts',
  './viem': './dist/viem.d.ts',
};

async function declarationFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directoryUrl);
      if (entry.isDirectory()) return declarationFiles(entryUrl);
      return entry.name.endsWith('.d.ts') ? [entryUrl] : [];
    }),
  );
  return nested.flat();
}

const manifest = JSON.parse(await readFile(new URL('package.json', packageRootUrl), 'utf8'));
const actualEntrypoints = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([subpath]) => subpath !== './package.json')
    .map(([subpath, value]) => [subpath, value.types]),
);
if (
  JSON.stringify(Object.entries(actualEntrypoints).toSorted()) !==
  JSON.stringify(Object.entries(expectedEntrypoints).toSorted())
) {
  throw new Error(
    `Public entrypoint declarations changed without updating the API gate:\n${JSON.stringify(actualEntrypoints, null, 2)}`,
  );
}

const packageRoot = fileURLToPath(packageRootUrl);
const files = (await declarationFiles(distUrl)).toSorted((left, right) =>
  left.pathname.localeCompare(right.pathname),
);
const declarations = Object.fromEntries(
  await Promise.all(
    files.map(async (fileUrl) => {
      const contents = await readFile(fileUrl);
      const path = relative(packageRoot, fileURLToPath(fileUrl)).replaceAll('\\', '/');
      return [path, createHash('sha256').update(contents).digest('hex')];
    }),
  ),
);
const report = {
  schemaVersion: 1,
  entrypoints: expectedEntrypoints,
  declarations,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;

if (process.argv.includes('--write')) {
  await writeFile(reportUrl, serialized);
  console.log(`Updated ${fileURLToPath(reportUrl)}`);
} else {
  const expected = await readFile(reportUrl, 'utf8');
  if (expected !== serialized) {
    throw new Error(
      'Public declarations differ from packages/client/api-report.json; review the API change and run pnpm api:report:write intentionally',
    );
  }
  console.log(`Verified ${files.length} declaration files against the public API report`);
}
