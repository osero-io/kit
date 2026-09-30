import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const scriptUrl = new URL('./prepare-changesets-release.mjs', import.meta.url);
const changeset = "---\n'@osero/client': patch\n---\n\nTest release.\n";

async function fixture(t, { preState, files = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'osero-release-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, '.changeset'));
  await copyFile(scriptUrl, join(root, 'scripts/prepare-changesets-release.mjs'));
  if (preState !== undefined) {
    await writeFile(join(root, '.changeset/pre.json'), JSON.stringify(preState));
  }
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const path = join(root, '.changeset', name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    }),
  );
  return root;
}

function prepare(root, branch, outputPath) {
  const env = { ...process.env };
  delete env.GITHUB_REF_NAME;
  delete env.GITHUB_OUTPUT;
  if (branch !== undefined) env.GITHUB_REF_NAME = branch;
  if (outputPath !== undefined) env.GITHUB_OUTPUT = outputPath;
  const result = spawnSync(process.execPath, ['scripts/prepare-changesets-release.mjs'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function expectOutputs(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  for (const [name, value] of Object.entries(expected)) {
    assert.ok(result.stdout.split('\n').includes(`${name}=${value}`), result.stdout);
  }
}

test('legacy consumed prerelease changesets do not prevent publishing or mutate state', async (t) => {
  const preState = {
    mode: 'pre',
    tag: 'next',
    initialVersions: { '@osero/client': '0.8.0' },
    changesets: ['consumed'],
  };
  const root = await fixture(t, { preState, files: { 'consumed.md': changeset } });
  expectOutputs(prepare(root, 'release/v1.0.0'), {
    release_kind: 'prerelease',
    version_script: 'pnpm version-packages',
    publishing: 'true',
  });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.changeset/pre.json'), 'utf8')), preState);
  assert.equal(await readFile(join(root, '.changeset/consumed.md'), 'utf8'), changeset);
  assert.deepEqual((await readdir(join(root, '.changeset'))).toSorted(), [
    'consumed.md',
    'pre.json',
  ]);
});

test('legacy prereleases with a new changeset must version first', async (t) => {
  const root = await fixture(t, {
    preState: { mode: 'pre', tag: 'next', changesets: ['consumed'] },
    files: { 'consumed.md': changeset, 'pending.md': changeset },
  });
  expectOutputs(prepare(root, 'release/v1.0.0'), { publishing: 'false' });
});

test('Changesets 3 archived prerelease changesets do not prevent publishing', async (t) => {
  const root = await fixture(t, {
    preState: { mode: 'pre', tag: 'next' },
    files: { 'pre/consumed.md': changeset },
  });
  expectOutputs(prepare(root, 'release/v1.0.0'), { publishing: 'true' });
});

test('Changesets 3 prereleases with new changesets must version first', async (t) => {
  const root = await fixture(t, {
    preState: { mode: 'pre', tag: 'next' },
    files: { 'pre/consumed.md': changeset, 'pending.md': changeset },
  });
  expectOutputs(prepare(root, 'release/v1.0.0'), { publishing: 'false' });
});

test('stable main without pending changesets requires publishing gates', async (t) => {
  const root = await fixture(t, {
    files: {
      'README.md': 'Instructions',
      'readme.md': 'Instructions',
      'AGENTS.md': 'Instructions',
      'CLAUDE.md': 'Instructions',
      'GEMINI.md': 'Instructions',
      '.hidden.md': 'Ignored',
    },
  });
  expectOutputs(prepare(root, 'main'), {
    release_kind: 'stable',
    version_script: 'pnpm version-packages',
    publishing: 'true',
  });
});

test('stable main with pending changesets must version first', async (t) => {
  const root = await fixture(t, { files: { 'pending.md': changeset } });
  expectOutputs(prepare(root, 'main'), { publishing: 'false' });
});

test('promotion from active pre mode creates one idempotent promotion changeset', async (t) => {
  const root = await fixture(t, { preState: { mode: 'pre', tag: 'next' } });
  const expected = {
    release_kind: 'stable-promotion',
    version_script: 'pnpm version-packages:stable',
    publishing: 'false',
  };
  expectOutputs(prepare(root, 'main'), expected);
  const path = join(root, '.changeset/promote-prerelease-to-stable.md');
  const initial = await readFile(path, 'utf8');
  assert.match(initial, /'@osero\/client': patch/);
  expectOutputs(prepare(root, 'main'), expected);
  assert.equal(await readFile(path, 'utf8'), initial);
});

test('promotion already in exit mode does not attempt pre exit again', async (t) => {
  const root = await fixture(t, { preState: { mode: 'exit', tag: 'next' } });
  expectOutputs(prepare(root, 'main'), {
    release_kind: 'stable-promotion',
    version_script: 'pnpm version-packages',
    publishing: 'false',
  });
});

test('promotion refuses to overwrite unexpected existing content', async (t) => {
  const root = await fixture(t, {
    preState: { mode: 'pre', tag: 'next' },
    files: { 'promote-prerelease-to-stable.md': 'Keep this content' },
  });
  const result = prepare(root, 'main');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected content/);
  assert.equal(
    await readFile(join(root, '.changeset/promote-prerelease-to-stable.md'), 'utf8'),
    'Keep this content',
  );
});

for (const [name, branch, preState, error] of [
  ['missing branch', undefined, undefined, /GITHUB_REF_NAME is required/],
  ['unsupported branch', 'feature/test', undefined, /Unsupported release branch/],
  ['release without prestate', 'release/v1.0.0', undefined, /active .* prerelease state/],
  [
    'release with exited prestate',
    'release/v1.0.0',
    { mode: 'exit', tag: 'next' },
    /active .* prerelease state/,
  ],
  [
    'release with latest tag',
    'release/v1.0.0',
    { mode: 'pre', tag: 'latest' },
    /latest npm dist-tag/,
  ],
  ['invalid mode', 'main', { mode: 'invalid', tag: 'next' }, /Invalid .* prerelease state/],
  ['empty tag', 'main', { mode: 'pre', tag: '' }, /Invalid .* prerelease state/],
  [
    'non-array legacy changesets',
    'main',
    { mode: 'pre', tag: 'next', changesets: 'consumed' },
    /Invalid .* prerelease state/,
  ],
  [
    'non-string legacy changeset',
    'main',
    { mode: 'pre', tag: 'next', changesets: [1] },
    /Invalid .* prerelease state/,
  ],
]) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t, { preState });
    const result = prepare(root, branch);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  });
}

test('writes outputs to GITHUB_OUTPUT when provided', async (t) => {
  const root = await fixture(t);
  const outputPath = join(root, 'outputs');
  const result = prepare(root, 'main', outputPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(outputPath, 'utf8'),
    'release_kind=stable\nversion_script=pnpm version-packages\npublishing=true\n',
  );
  assert.equal(result.stdout, 'Prepared stable release on main\n');
});
