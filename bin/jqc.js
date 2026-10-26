#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/cli.js', import.meta.url);
const src = new URL('../src/cli.ts', import.meta.url);

if (existsSync(fileURLToPath(dist))) {
  await import(dist.href);
} else {
  await import(src.href);
}
