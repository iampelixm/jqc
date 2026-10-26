#!/usr/bin/env node
/**
 * Build jqc into a single self-contained macOS binary using Node SEA
 * (Single Executable Application).
 *
 *   1. esbuild bundles src/cli.ts + dependencies (jsonc-parser, json5) into one CJS file
 *   2. node --experimental-sea-config produces the SEA blob
 *   3. a copy of the running Node binary is stitched together with postject
 *   4. ad-hoc codesign (required on Apple Silicon)
 *
 * Usage:
 *   node scripts/build-binary.mjs           -> dist/jqc
 *   node scripts/build-binary.mjs --clean   -> also remove intermediate files
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');
const binPath = join(outDir, 'jqc');
const bundlePath = join(outDir, 'sea', 'bundle.cjs');
const blobPath = join(outDir, 'sea', 'sea-prep.blob');
const clean = process.argv.includes('--clean');

const nodeBin = process.execPath;

function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

console.log('== 1/4 bundle with esbuild ==');
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: bundlePath,
  sourcemap: false,
  // Prefer ESM builds of dependencies: jsonc-parser's UMD wrapper keeps a
  // factory-scoped `require` that bundling cannot inline and that breaks
  // inside the embedded SEA require.
  mainFields: ['module', 'main'],
});

console.log('== 2/4 generate SEA blob ==');
mkdirSync(join(outDir, 'sea'), { recursive: true });
const seaConfig = join(root, 'dist', 'sea', 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
sh(process.execPath, ['--experimental-sea-config', seaConfig]);

console.log('== 3/4 inject blob into a copy of node ==');
if (existsSync(binPath)) rmSync(binPath);
cpSync(nodeBin, binPath);
try {
  // remove any existing signature so the injected binary can be re-signed
  sh('codesign', ['--remove-signature', binPath]);
} catch {
  /* unsigned already */
}
sh(
  join(root, 'node_modules', '.bin', 'postject'),
  [
    binPath,
    'NODE_SEA_BLOB',
    blobPath,
    // Node >= 25 looks for the resource inside the segment named "NODE_SEA"
    // (see src/node_sea.cc: FindSingleExecutableBlob). postject's default
    // segment is "__POSTJECT", which the runtime cannot find.
    '--macho-segment-name',
    'NODE_SEA',
    // Node 25 binaries still carry the classic fuse as their sentinel;
    // postject 1.0 looks for POSTJECT_SENTINEL_... by default.
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
);
sh('chmod', ['+x', binPath]);

console.log('== 4/4 ad-hoc codesign (Apple Silicon) ==');
try {
  sh('codesign', ['--sign', '-', binPath]);
} catch {
  console.warn('codesign unavailable; the binary may need manual signing');
}

console.log(`\n✅ binary: ${binPath}`);
console.log(`   size:   ${existsSync(binPath) ? statSync(binPath).size : 0} bytes`);

if (clean) {
  rmSync(join(outDir, 'sea'), { recursive: true, force: true });
}