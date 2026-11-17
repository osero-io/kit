// Bundles the browser-supported entrypoints of the built SDK for the browser and
// fails if anything in their dependency graph needs a Node.js built-in module.
//
// Run after `pnpm build`. `@osero/client/privy` is deliberately absent: it wraps
// the server-side `@privy-io/node` SDK and is supported on Node.js only.
import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('../packages/client/', import.meta.url));

/** Public subpath -> built file, for every entrypoint documented as browser-safe. */
export const BROWSER_ENTRYPOINTS = {
  '.': 'dist/index.js',
  './actions': 'dist/lib/actions/index.js',
  './api': 'dist/api.js',
  './contracts': 'dist/contracts.js',
  './viem': 'dist/viem.js',
  './eip5792': 'dist/eip5792.js',
  './ethers': 'dist/ethers.js',
};

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Records every import of a Node.js built-in that esbuild is asked to resolve.
 * A dependency that maps a built-in to an empty module through its `browser`
 * field never reaches this hook, which is the behaviour a browser bundler has.
 */
function nodeBuiltinGuard(found) {
  return {
    name: 'node-builtin-guard',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (!builtins.has(args.path)) return undefined;
        found.push({ specifier: args.path, importer: args.importer });
        // Keep bundling so one run reports every offender.
        return { path: args.path, external: true };
      });
    },
  };
}

export async function checkBrowserBundle(subpath, file) {
  const entry = `${packageRoot}${file}`;
  if (!existsSync(entry)) {
    throw new Error(`${entry} does not exist; run pnpm build before pnpm browser:check`);
  }
  const found = [];
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    absWorkingDir: packageRoot,
    plugins: [nodeBuiltinGuard(found)],
  });
  const bytes = result.outputFiles.reduce((total, output) => total + output.contents.length, 0);
  return { subpath, bytes, found };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let results;
  try {
    results = await Promise.all(
      Object.entries(BROWSER_ENTRYPOINTS).map(([subpath, file]) =>
        checkBrowserBundle(subpath, file).catch((error) => {
          throw new Error(
            `Browser bundle of ${subpath} failed:\n${error instanceof Error ? error.message : error}`,
          );
        }),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const offenders = results.filter((result) => result.found.length > 0);
  if (offenders.length > 0) {
    for (const { subpath, found } of offenders) {
      console.error(`${subpath} needs Node.js built-ins in a browser bundle:`);
      for (const { specifier, importer } of found) {
        console.error(`  ${specifier}  <-  ${importer}`);
      }
    }
    process.exit(1);
  }
  for (const { subpath, bytes } of results) {
    console.log(
      `${subpath.padEnd(12)} bundles for the browser (${(bytes / 1024).toFixed(0)} kB unminified, dependencies included)`,
    );
  }
  console.log(`Verified ${results.length} browser entrypoints import no Node.js built-in module`);
}
