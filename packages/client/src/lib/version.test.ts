import { readFileSync } from 'node:fs';

import { SDK_VERSION } from './version.js';

describe('SDK_VERSION', () => {
  it('matches the package.json version', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(SDK_VERSION).toBe(manifest.version);
  });
});
