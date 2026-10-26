import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parsePath, PathError } from '../src/path.ts';
import { detect, validate } from '../src/formats.ts';
import { blankComments, blankTrailingCommas, toJqText } from '../src/normalize.ts';
import { formatDocument } from '../src/format.ts';
import { detectStyle } from '../src/style.ts';
import { setValue, deleteValue, getValue } from '../src/edit.ts';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/tsconfig.jsonc', import.meta.url)), 'utf8');
const style = detectStyle(fixture);

test('parsePath understands dot, bracket and quoted forms', () => {
  assert.deepEqual(parsePath('a.b'), ['a', 'b']);
  assert.deepEqual(parsePath('$.a.b'), ['a', 'b']);
  assert.deepEqual(parsePath('a[0].b'), ['a', 0, 'b']);
  assert.deepEqual(parsePath('a["b.c"]'), ['a', 'b.c']);
  assert.deepEqual(parsePath("a.'d e'"), ['a', 'd e']);
  assert.deepEqual(parsePath('a[-1]'), ['a', -1]);
  assert.deepEqual(parsePath('$'), []);
  assert.throws(() => parsePath('a..b'), PathError);
  assert.throws(() => parsePath('a[oops]'), PathError);
  // keys that look like numbers stay strings when dotted
  assert.deepEqual(parsePath('a.0'), ['a', '0']);
});

test('detect picks the narrowest format that fits', () => {
  assert.equal(detect('{"a":1}'), 'json');
  assert.equal(detect('{\n  // c\n  "a": 1,\n}'), 'jsonc');
  assert.equal(detect("{a: 'x'}"), 'json5');
  assert.equal(detect('{"a":1}\n{"b":2}'), 'ndjson');
  assert.equal(detect('[1,2]\n[3]'), 'ndjson');
  assert.throws(() => detect('{'));
});

test('blankComments keeps every offset in place', () => {
  const src = '{\n  // note\n  "a": "http://x", /* tail */\n  "b": 1\n}';
  const blanked = blankComments(src);
  assert.equal(blanked.length, src.length);
  assert.equal(blanked.split('\n').length, src.split('\n').length);
  // string contents survive untouched
  assert.ok(blanked.includes('"http://x"'));
  assert.deepEqual(JSON.parse(blanked), { a: 'http://x', b: 1 });
});

test('blankTrailingCommas removes only the trailing ones', () => {
  assert.equal(blankTrailingCommas('[1,2,]'), '[1,2 ]');
  assert.equal(blankTrailingCommas('{"a":[1,],"b":2}'), '{"a":[1 ],"b":2}');
  assert.equal(blankTrailingCommas('["a,]"]'), '["a,]"]');
});

test('toJqText turns JSONC into strict JSON jq can read', () => {
  const strict = toJqText(fixture, 'jsonc');
  assert.doesNotThrow(() => JSON.parse(strict));
  assert.equal(strict.split('\n').length, fixture.split('\n').length);
});

test('validate reports positions', () => {
  const issues = validate('{\n  "a": ,\n}', 'jsonc');
  assert.equal(issues.length, 1);
});

test('formatDocument leaves a well-formatted JSONC file untouched', () => {
  assert.equal(formatDocument(fixture, style, 'preserve'), fixture);
});

test('formatDocument keeps inline arrays and comments', () => {
  const src = '{"a":[1,2],  "b":{ "c":3 } // note\n}';
  const out = formatDocument(src, { insertSpaces: true, tabSize: 2, eol: '\n' }, 'preserve');
  assert.equal(out, '{\n  "a": [1, 2],\n  "b": {"c": 3} // note\n}\n');
  assert.equal(formatDocument(out, { insertSpaces: true, tabSize: 2, eol: '\n' }), out);
});

test('formatDocument canonical is idempotent and stable', () => {
  const once = formatDocument(fixture, style, 'canonical');
  assert.equal(formatDocument(once, style, 'canonical'), once);
  assert.ok(once.includes('// TypeScript configuration'));
  assert.ok(once.includes('/* Paths below'));
});

test('setValue edits the value and nothing else', () => {
  const out = setValue(fixture, 'jsonc', parsePath('compilerOptions.target'), 'ES2023', style);
  assert.equal(out, fixture.replace('"ES2022"', '"ES2023"'));
});

test('setValue adds a new key with the document indentation', () => {
  const out = setValue(fixture, 'jsonc', parsePath('compilerOptions.jsx'), 'react-jsx', style);
  assert.ok(out.includes('    "jsx": "react-jsx"\n  },') || out.includes('"jsx": "react-jsx"'));
  assert.ok(out.includes('// TypeScript configuration'));
  assert.equal(getValue(out, 'jsonc', parsePath('compilerOptions.jsx')).value, 'react-jsx');
});

test('setValue creates missing intermediate objects', () => {
  const out = setValue(fixture, 'jsonc', parsePath('compilerOptions.paths["@ui/*"]'), ['./src/ui/*'], style);
  const value = getValue(out, 'jsonc', parsePath('compilerOptions.paths["@ui/*"]'));
  assert.deepEqual(value.value, ['./src/ui/*']);
  assert.ok(out.includes('"@app/*": ["./src/*"],'));
});

test('setValue resolves negative array indices', () => {
  const src = '{\n  "include": ["a", "b"]\n}\n';
  const out = setValue(src, 'json', parsePath('include[-1]'), 'c', { insertSpaces: true, tabSize: 2, eol: '\n' });
  assert.deepEqual(getValue(out, 'json', parsePath('include')).value, ['a', 'c']);
});

test('deleteValue removes a middle property and keeps strict JSON valid', () => {
  const src = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
  const out = deleteValue(src, 'json', parsePath('b'));
  assert.deepEqual(JSON.parse(out), { a: 1, c: 3 });
});

test('deleteValue removes the last property without eating the closing brace', () => {
  const out = deleteValue(fixture, 'jsonc', parsePath('exclude'));
  assert.ok(out.endsWith('"include": ["src/**/*.ts"]\n}\n'));
  assert.ok(!out.includes('"dist"'));
});

test('deleteValue removes array elements', () => {
  const src = '{\n  "a": [1, 2, 3]\n}\n';
  assert.deepEqual(JSON.parse(deleteValue(src, 'json', parsePath('a[1]'))), { a: [1, 3] });
  assert.deepEqual(JSON.parse(deleteValue(src, 'json', parsePath('a[2]'))), { a: [1, 2] });
  assert.deepEqual(JSON.parse(deleteValue(src, 'json', parsePath('a[0]'))), { a: [2, 3] });
});
