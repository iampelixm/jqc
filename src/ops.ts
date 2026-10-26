import JSON5 from 'json5';
import {
  type Format,
  type ParseIssue,
  FormatError,
  detect,
  parseOne,
  parseValues,
  validate,
} from './formats.ts';
import { type EditStyle, type ReadResult, deepEqual, formatText, readValue, resolvePath, setValue } from './edit.ts';
import { type Seg, formatPath } from './path.ts';

export function resolveFormat(text: string, requested: Format | 'auto'): Format {
  return requested === 'auto' ? detect(text) : requested;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringify(value: unknown, style: EditStyle): string {
  const indent = style.insertSpaces ? style.tabSize : '\t';
  const body = JSON.stringify(value, null, indent) ?? 'null';
  const text = style.eol === '\n' ? body : body.replace(/\n/g, style.eol);
  return `${text}${style.eol}`;
}

export interface ValidationResult {
  format: Format;
  issues: ParseIssue[];
}

export function validateDoc(text: string, requested: Format | 'auto'): ValidationResult {
  let format: Format;
  try {
    format = resolveFormat(text, requested);
  } catch (error) {
    if (error instanceof FormatError) return { format: error.format, issues: error.issues };
    throw error;
  }
  return { format, issues: validate(text, format) };
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = deepSort(value[key]);
    return out;
  }
  return value;
}

export interface FormatResult {
  text: string;
  commentsLost: boolean;
}

export function formatDoc(
  text: string,
  requested: Format | 'auto',
  style: EditStyle,
  opts: { sortKeys?: boolean; canonical?: boolean } = {},
): FormatResult {
  const format = resolveFormat(text, requested);
  if (format === 'ndjson') {
    const values = parseValues(text, format);
    return { text: `${values.map((v) => JSON.stringify(v)).join(style.eol)}${style.eol}`, commentsLost: false };
  }
  if (opts.sortKeys) {
    const value = parseOne(text, format);
    return { text: stringify(deepSort(value), style), commentsLost: format === 'jsonc' };
  }
  return { text: formatText(text, style, { canonical: opts.canonical }), commentsLost: false };
}

export function convertDoc(
  text: string,
  requested: Format | 'auto',
  target: Format,
  style: EditStyle,
): string {
  const format = resolveFormat(text, requested);
  if (format === 'jsonc' && target === 'jsonc') return formatText(text, style);

  const values = parseValues(text, format);
  const single = values.length === 1 ? values[0] : values;

  switch (target) {
    case 'json':
    case 'jsonc':
      return stringify(single, style);
    case 'json5': {
      const indent = style.insertSpaces ? style.tabSize : '\t';
      const body = JSON5.stringify(single, null, indent) ?? 'null';
      return `${body}${style.eol}`;
    }
    case 'ndjson': {
      const list = values.length === 1 && Array.isArray(values[0]) ? (values[0] as unknown[]) : values;
      return `${list.map((v) => JSON.stringify(v)).join(style.eol)}${style.eol}`;
    }
  }
}

interface SetOp {
  path: Seg[];
  value: unknown;
}

function collectMergeOps(
  base: unknown,
  overlay: unknown,
  prefix: Seg[],
  out: SetOp[],
  arrays: 'replace' | 'concat',
): void {
  if (isPlainObject(base) && isPlainObject(overlay)) {
    for (const [key, value] of Object.entries(overlay)) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        collectMergeOps(base[key], value, [...prefix, key], out, arrays);
      } else {
        out.push({ path: [...prefix, key], value });
      }
    }
    return;
  }

  if (Array.isArray(base) && Array.isArray(overlay) && arrays === 'concat') {
    if (overlay.length === 0) return;
    out.push({ path: prefix, value: [...base, ...overlay] });
    return;
  }

  if (deepEqual(base, overlay)) return;
  out.push({ path: prefix, value: overlay });
}

export interface MergeResult {
  text: string;
  commentsLost: boolean;
  changes: number;
}

export function mergeDocs(
  baseText: string,
  baseRequested: Format | 'auto',
  overlayText: string,
  overlayRequested: Format | 'auto',
  style: EditStyle,
  opts: { arrays?: 'replace' | 'concat' } = {},
): MergeResult {
  const baseFormat = resolveFormat(baseText, baseRequested);
  const overlayFormat = resolveFormat(overlayText, overlayRequested);
  const base = parseOne(baseText, baseFormat);
  const overlay = parseOne(overlayText, overlayFormat);

  // JSON5 cannot round-trip, so fall back to a rebuilt document.
  if (baseFormat === 'json5' || baseFormat === 'ndjson') {
    const ops: SetOp[] = [];
    collectMergeOps(base, overlay, [], ops, opts.arrays ?? 'replace');
    return { text: stringify(overlayMerged(base, overlay, opts), style), commentsLost: true, changes: ops.length };
  }

  const ops: SetOp[] = [];
  collectMergeOps(base, overlay, [], ops, opts.arrays ?? 'replace');

  let text = baseText;
  const ordered = [...ops].sort((a, b) => a.path.length - b.path.length);
  for (const op of ordered) {
    if (op.path.length === 0) {
      text = stringify(op.value, style);
      continue;
    }
    text = setValue(text, baseFormat, op.path, op.value, style);
  }
  return { text, commentsLost: false, changes: ops.length };
}

function overlayMerged(base: unknown, overlay: unknown, opts: { arrays?: 'replace' | 'concat' }): unknown {
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      out[key] = Object.prototype.hasOwnProperty.call(base, key)
        ? overlayMerged(base[key], value, opts)
        : value;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(overlay) && opts.arrays === 'concat') return [...base, ...overlay];
  return overlay;
}

export interface DiffEntry {
  op: 'add' | 'del' | 'chg';
  path: string;
  before?: unknown;
  after?: unknown;
}

function diffValues(a: unknown, b: unknown, prefix: Seg[], out: DiffEntry[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of Object.keys(a)) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) out.push({ op: 'del', path: formatPath([...prefix, key]), before: a[key] });
    }
    for (const key of Object.keys(b)) {
      if (!Object.prototype.hasOwnProperty.call(a, key)) {
        out.push({ op: 'add', path: formatPath([...prefix, key]), after: b[key] });
      } else {
        diffValues(a[key], b[key], [...prefix, key], out);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (i >= a.length) out.push({ op: 'add', path: formatPath([...prefix, i]), after: b[i] });
      else if (i >= b.length) out.push({ op: 'del', path: formatPath([...prefix, i]), before: a[i] });
      else diffValues(a[i], b[i], [...prefix, i], out);
    }
    return;
  }
  if (!deepEqual(a, b)) {
    out.push({ op: 'chg', path: formatPath(prefix), before: a, after: b });
  }
}

export function diffDocs(
  aText: string,
  aRequested: Format | 'auto',
  bText: string,
  bRequested: Format | 'auto',
): DiffEntry[] {
  const a = parseOne(aText, resolveFormat(aText, aRequested));
  const b = parseOne(bText, resolveFormat(bText, bRequested));
  const out: DiffEntry[] = [];
  diffValues(a, b, [], out);
  return out;
}

export function lookup(text: string, format: Format, segs: Seg[]): ReadResult {
  const root = parseOne(text, format);
  return readValue(root, resolvePath(root, segs));
}

export function renderDiff(entries: DiffEntry[]): string {
  const short = (v: unknown): string => {
    const s = JSON.stringify(v);
    if (s === undefined) return 'undefined';
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  };
  return entries
    .map((e) => {
      if (e.op === 'add') return `+ ${e.path}: ${short(e.after)}`;
      if (e.op === 'del') return `- ${e.path}: ${short(e.before)}`;
      return `~ ${e.path}: ${short(e.before)} -> ${short(e.after)}`;
    })
    .join('\n');
}
