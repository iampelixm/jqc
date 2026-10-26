import { type Format, parseOne } from './formats.ts';
import { type Seg, formatPath } from './path.ts';
import { type EditStyle, EditError } from './style.ts';
import { deleteAtPath, setAtPath } from './cst.ts';
import { formatDocument } from './format.ts';

export { EditError, detectStyle, styleFrom, indentUnit } from './style.ts';
export type { EditStyle } from './style.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export interface ReadResult {
  found: boolean;
  value: unknown;
}

/** Resolve negative array indices against the actual document. */
export function resolvePath(root: unknown, segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  let cur: unknown = root;
  for (const seg of segs) {
    if (typeof seg === 'number' && seg < 0) {
      if (!Array.isArray(cur)) {
        throw new EditError(`negative index ${seg} applied to a non-array at ${formatPath(out)}`);
      }
      const idx = cur.length + seg;
      if (idx < 0) throw new EditError(`index ${seg} is out of range at ${formatPath(out)} (length ${cur.length})`);
      out.push(idx);
      cur = cur[idx];
      continue;
    }
    out.push(seg);
    if (typeof seg === 'number') cur = Array.isArray(cur) ? cur[seg] : undefined;
    else cur = isObject(cur) ? cur[seg] : undefined;
  }
  return out;
}

export function readValue(root: unknown, segs: Seg[]): ReadResult {
  let cur: unknown = root;
  for (const seg of segs) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur) || seg < 0 || seg >= cur.length) return { found: false, value: undefined };
      cur = cur[seg];
    } else {
      if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = cur[seg];
    }
  }
  return { found: true, value: cur };
}

export function getValue(text: string, format: Format, segs: Seg[]): ReadResult {
  const root = parseOne(text, format);
  return readValue(root, resolvePath(root, segs));
}

function guardFormat(format: Format): void {
  if (format === 'ndjson') {
    throw new EditError('edit commands operate on a single document; use jq for NDJSON streams');
  }
}

/** Set a value, keeping comments, key order and unrelated formatting untouched. */
export function setValue(text: string, format: Format, segs: Seg[], value: unknown, style: EditStyle): string {
  guardFormat(format);
  const root = parseOne(text, format);
  const path = resolvePath(root, segs);
  const before = readValue(root, path);
  if (before.found && deepEqual(before.value, value)) return text;

  const next = setAtPath(text, path, value, style);
  let applied: ReadResult;
  try {
    applied = readValue(parseOne(next, format), path);
  } catch {
    throw new EditError(`edit of ${formatPath(path)} produced an invalid document`);
  }
  if (!applied.found || !deepEqual(applied.value, value)) {
    throw new EditError(`edit of ${formatPath(path)} did not apply`);
  }
  return next;
}

function cloneRemove(root: unknown, segs: Seg[]): unknown {
  const [head, ...rest] = segs;
  if (head === undefined) return root;
  if (Array.isArray(root) && typeof head === 'number') {
    const copy = root.slice();
    if (rest.length === 0) copy.splice(head, 1);
    else copy[head] = cloneRemove(copy[head], rest);
    return copy;
  }
  if (isObject(root) && typeof head === 'string') {
    const copy = { ...root };
    if (rest.length === 0) delete copy[head];
    else copy[head] = cloneRemove(copy[head], rest);
    return copy;
  }
  return root;
}

/** Delete a value. Array elements are removed, not set to null. */
export function deleteValue(text: string, format: Format, segs: Seg[]): string {
  guardFormat(format);
  const root = parseOne(text, format);
  const path = resolvePath(root, segs);
  if (!readValue(root, path).found) throw new EditError(`${formatPath(path)} not found`);

  const expected = cloneRemove(root, path);
  const next = deleteAtPath(text, path);

  let after: unknown;
  try {
    after = parseOne(next, format);
  } catch {
    throw new EditError(`delete of ${formatPath(path)} produced an invalid document`);
  }
  if (!deepEqual(after, expected)) {
    throw new EditError(`delete of ${formatPath(path)} did not apply`);
  }
  return next;
}

/** Re-indent the document while keeping comments in place. */
export function formatText(text: string, style: EditStyle, opts: { canonical?: boolean } = {}): string {
  return formatDocument(text, style, opts.canonical ? 'canonical' : 'preserve');
}
