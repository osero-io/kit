import { readFile } from 'node:fs/promises';

const [statusPath] = process.argv.slice(2);
if (!statusPath) {
  throw new Error('Usage: node scripts/check-release-changeset.mjs <changeset-status.json>');
}

const status = JSON.parse(await readFile(statusPath, 'utf8'));
if (!Array.isArray(status.changesets)) {
  throw new Error('Invalid Changesets status output');
}

const clientChangesets = status.changesets.filter(
  (changeset) =>
    Array.isArray(changeset.releases) &&
    changeset.releases.some((release) => release.name === '@osero/client'),
);
if (clientChangesets.length === 0) {
  throw new Error(
    'Pull requests into a release branch must include a non-empty @osero/client changeset',
  );
}

console.log(`Verified ${clientChangesets.length} @osero/client changeset(s)`);
