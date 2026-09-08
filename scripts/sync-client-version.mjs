import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const manifestUrl = new URL('../packages/client/package.json', import.meta.url);
const versionUrl = new URL('../packages/client/src/lib/version.ts', import.meta.url);

const { version } = JSON.parse(await readFile(manifestUrl, 'utf8'));
if (typeof version !== 'string' || version.length === 0) {
  throw new Error('packages/client/package.json has no version');
}

const source = await readFile(versionUrl, 'utf8');
const updated = source.replace(
  /export const SDK_VERSION = '[^']*';/,
  `export const SDK_VERSION = '${version}';`,
);
if (!updated.includes(`SDK_VERSION = '${version}'`)) {
  throw new Error(`Could not find SDK_VERSION in ${fileURLToPath(versionUrl)}`);
}
if (updated !== source) {
  await writeFile(versionUrl, updated);
  console.log(`Synced SDK_VERSION to ${version}`);
}
