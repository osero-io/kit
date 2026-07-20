import { appendFile, readFile, writeFile } from 'node:fs/promises';

const preStateUrl = new URL('../.changeset/pre.json', import.meta.url);
const promotionChangesetUrl = new URL(
  '../.changeset/promote-prerelease-to-stable.md',
  import.meta.url,
);
const promotionChangeset = `---
'@osero/client': patch
---

Promote the prerelease line to a stable release.
`;

async function readPreState() {
  try {
    const value = JSON.parse(await readFile(preStateUrl, 'utf8'));
    if (
      value === null ||
      typeof value !== 'object' ||
      (value.mode !== 'pre' && value.mode !== 'exit') ||
      typeof value.tag !== 'string' ||
      value.tag.length === 0
    ) {
      throw new Error('Invalid .changeset/pre.json prerelease state');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

async function ensurePromotionChangeset() {
  try {
    await writeFile(promotionChangesetUrl, promotionChangeset, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const current = await readFile(promotionChangesetUrl, 'utf8');
    if (current !== promotionChangeset) {
      throw new Error(
        '.changeset/promote-prerelease-to-stable.md already exists with unexpected content',
        { cause: error },
      );
    }
  }
}

const branch = process.env.GITHUB_REF_NAME;
if (!branch) {
  throw new Error('GITHUB_REF_NAME is required');
}

const preState = await readPreState();
let releaseKind = 'stable';
let versionScript = 'pnpm version-packages';

if (branch.startsWith('release/')) {
  if (!preState || preState.mode !== 'pre') {
    throw new Error(`${branch} must contain an active .changeset/pre.json prerelease state`);
  }
  if (preState.tag === 'latest') {
    throw new Error('Prerelease branches cannot publish with the latest npm dist-tag');
  }
  releaseKind = 'prerelease';
} else if (branch === 'main') {
  if (preState) {
    await ensurePromotionChangeset();
    releaseKind = 'stable-promotion';
    if (preState.mode === 'pre') {
      versionScript = 'pnpm version-packages:stable';
    }
  }
} else {
  throw new Error(`Unsupported release branch: ${branch}`);
}

await writeOutput('release_kind', releaseKind);
await writeOutput('version_script', versionScript);
console.log(`Prepared ${releaseKind} release on ${branch}`);
