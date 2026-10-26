import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

let dir = '';

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jqc-test-'));
});

const JSONC = `{
  // demo config
  "name": "app",
  "scripts": {
    "build": "tsc", // primary
    "test": "node --test"
  },
  "deps": ["a", "b"],
}
`;

async function file(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

test('query mode reads JSONC and passes jq flags through', async () => {
  const path = await file('q.jsonc', JSONC);
  const r = await run(['-r', '.scripts.build', path]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'tsc\n');

  const arg = await run(['--arg', 'env', 'prod', '-r', '.name + "/" + $env', path]);
  assert.equal(arg.stdout, 'app/prod\n');
});

test('query mode reads JSON5', async () => {
  const path = await file('q.json5', "{name: 'app', list: [1, 2,],}\n");
  const r = await run(['-c', '.', path]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '{"name":"app","list":[1,2]}\n');
});

test('query mode reads NDJSON', async () => {
  const path = await file('q.ndjson', '{"a":1}\n{"a":2}\n');
  const r = await run(['-s', '-c', 'map(.a)', path]);
  assert.equal(r.stdout, '[1,2]\n');
});

test('get returns a value and a non-zero exit when missing', async () => {
  const path = await file('g.jsonc', JSONC);
  const ok = await run(['get', '.scripts.test', path]);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, '"node --test"\n');

  const raw = await run(['get', '.name', path, '-r']);
  assert.equal(raw.stdout, 'app\n');

  const missing = await run(['get', '.nope', path]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not found/);
});

test('set rewrites only the targeted value', async () => {
  const path = await file('s.jsonc', JSONC);
  const r = await run(['set', '.scripts.build', 'tsc --build', path, '-w']);
  assert.equal(r.code, 0);
  const text = await readFile(path, 'utf8');
  assert.equal(text, JSONC.replace('"build": "tsc"', '"build": "tsc --build"'));
});

test('set adds a key and keeps comments', async () => {
  const path = await file('s2.jsonc', JSONC);
  await run(['set', '.scripts.lint', 'eslint .', path, '-w']);
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('// primary'));
  assert.ok(text.includes('"lint": "eslint ."'));
  const check = await run(['get', '.scripts.lint', path, '-r']);
  assert.equal(check.stdout, 'eslint .\n');
});

test('del removes a key and leaves the document valid', async () => {
  const path = await file('d.jsonc', JSONC);
  const r = await run(['del', '.scripts.test', path, '-w']);
  assert.equal(r.code, 0);
  const text = await readFile(path, 'utf8');
  assert.ok(!text.includes('node --test'));
  const valid = await run(['validate', path, '-q']);
  assert.equal(valid.code, 0);
});

test('validate reports positions and exit codes', async () => {
  const bad = await file('bad.json', '{\n  "a": ,\n}\n');
  const r = await run(['validate', bad]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bad\.json:2:8/);

  const good = await file('good.jsonc', JSONC);
  const ok = await run(['validate', good]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /OK \(jsonc\)/);
});

test('fmt --check is clean on a formatted file and dirty on a squeezed one', async () => {
  const clean = await file('f1.jsonc', JSONC);
  // The JSONC fixture already matches canonical formatting
  assert.equal((await run(['fmt', '--check', clean])).code, 0);

  // A long minified line gets reformatted into canonical multiline.
  // Each object whose inline width exceeds 60 chars is expanded,
  // short ones stay inline.
  const squeezed = await file(
    'f2.json',
    '{"name":"app","scripts":{"build":"tsc --build --verbose --longflag --verbose2","test":"node --test --experimental-modules --tier=3"}}',
  );
  assert.equal((await run(['fmt', '--check', squeezed])).code, 1);
  const out = await run(['fmt', squeezed]);
  const expected = `{\n  "name": "app",\n  "scripts": {\n    "build": "tsc --build --verbose --longflag --verbose2",\n    "test": "node --test --experimental-modules --tier=3"\n  }\n}\n`;
  assert.equal(out.stdout, expected);
  // fmt is idempotent
  const again = await run(['fmt', '-'], expected);
  assert.equal(again.stdout, expected);
});

test('convert switches formats', async () => {
  const path = await file('c.json', '{"a":[1,2]}\n');
  const nd = await run(['convert', path, '--to', 'ndjson']);
  assert.equal(nd.stdout, '{"a":[1,2]}\n');

  const j5 = await run(['convert', path, '--to', 'json5']);
  assert.match(j5.stdout, /a: \[/);
});

test('merge keeps comments from the base document', async () => {
  const base = await file('m1.jsonc', JSONC);
  const overlay = await file('m2.json', '{"scripts":{"build":"vite build"},"extra":true}\n');
  const r = await run(['merge', base, overlay]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('// demo config'));
  assert.ok(r.stdout.includes('// primary'));
  assert.ok(r.stdout.includes('"build": "vite build"'));
  assert.ok(r.stdout.includes('"extra": true'));
  assert.ok(r.stdout.includes('"test": "node --test"'));
});

test('diff is structural and honours --exit-code', async () => {
  const a = await file('x.jsonc', '{"a":1}\n');
  const b = await file('y.json', '{\n  "a": 1\n}\n');
  assert.equal((await run(['diff', a, b])).code, 0);

  const c = await file('z.json', '{"a":2}\n');
  const diff = await run(['diff', a, c, '--exit-code']);
  assert.equal(diff.code, 1);
  assert.match(diff.stdout, /~ \$\.a: 1 -> 2/);
});

test('bad usage exits with 2 and prints a hint', async () => {
  const r = await run(['get', '.a', '--nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown option/);
});

test('stdin is accepted by edit commands', async () => {
  const r = await run(['set', '.a', '2', '--indent', '2'], '{"a":1}\n');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '{"a":2}\n');
});
