import * as jsonc from 'jsonc-parser';
import type { Seg } from './path.ts';
import { type EditStyle, EditError, indentUnit } from './style.ts';

const PARSE_OPTIONS: jsonc.ParseOptions = { allowTrailingComma: true, disallowComments: false };
const MAX_INLINE = 60;

export function parseRoot(text: string): jsonc.Node {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(text, errors, PARSE_OPTIONS);
  if (!root || errors.length > 0) throw new EditError('document has syntax errors');
  return root;
}

function childrenOf(node: jsonc.Node): jsonc.Node[] {
  return node.children ?? [];
}

function propertyFor(obj: jsonc.Node, key: string): jsonc.Node | undefined {
  for (const prop of childrenOf(obj)) {
    const k = prop.children?.[0];
    if (k && k.value === key) return prop;
  }
  return undefined;
}

function arrayIndex(arr: jsonc.Node, seg: number): number {
  const len = childrenOf(arr).length;
  return seg < 0 ? len + seg : seg;
}

export function inlineJson(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? 'null' : s;
}

function prettyJson(value: unknown, style: EditStyle): string {
  const unit = indentUnit(style);
  const eol = style.eol;
  const walk = (val: unknown, level: number): string => {
    const pad = unit.repeat(level);
    const inner = unit.repeat(level + 1);
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const items = val.map((item) => `${inner}${walk(item, level + 1)}`).join(`,${eol}`);
      return `[${eol}${items}${eol}${pad}]`;
    }
    if (typeof val === 'object' && val !== null) {
      const entries = Object.entries(val as Record<string, unknown>);
      if (entries.length === 0) return '{}';
      const items = entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${walk(v, level + 1)}`).join(`,${eol}`);
      return `{${eol}${items}${eol}${pad}}`;
    }
    return JSON.stringify(val) ?? 'null';
  };
  return walk(value, 0);
}

/** Inline when short, multi-line otherwise. `pad` indents continuation lines. */
export function serializeValue(value: unknown, style: EditStyle, pad = ''): string {
  const flat = inlineJson(value);
  if (!flat.includes('\n') && flat.length <= MAX_INLINE) return flat;
  const pretty = prettyJson(value, style);
  return pad === '' ? pretty : pretty.split(style.eol).join(style.eol + pad);
}

function lineStartOf(text: string, offset: number): number {
  const idx = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return idx === -1 ? 0 : idx + 1;
}

function lineEndOf(text: string, offset: number): number {
  const idx = text.indexOf('\n', offset);
  return idx === -1 ? text.length : idx;
}

function leadingWhitespace(text: string, lineStart: number): string {
  let i = lineStart;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(lineStart, i);
}

function replaceNode(text: string, node: jsonc.Node, value: unknown, style: EditStyle): string {
  const pad = leadingWhitespace(text, lineStartOf(text, node.offset));
  const rendered = serializeValue(value, style, pad);
  return text.slice(0, node.offset) + rendered + text.slice(node.offset + node.length);
}

function buildValue(keys: Seg[], value: unknown): unknown {
  let out: unknown = value;
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i]!;
    if (typeof key === 'number') {
      if (key !== 0) throw new EditError('cannot create array elements out of order; create the array first');
      out = [out];
    } else {
      out = { [key]: out };
    }
  }
  return out;
}

interface Hit {
  node: jsonc.Node;
  depth: number;
  parent?: jsonc.Node;
  unit: jsonc.Node;
}

/** Walk as far down the path as the document allows. */
function findDeepest(root: jsonc.Node, segs: Seg[]): Hit {
  let node = root;
  let unit = root;
  let parent: jsonc.Node | undefined;
  let depth = 0;

  while (depth < segs.length) {
    const seg = segs[depth]!;

    if (node.type === 'object' && typeof seg === 'string') {
      const prop = propertyFor(node, seg);
      if (!prop) break;
      const value = prop.children?.[1];
      if (!value) break;
      parent = node;
      unit = prop;
      node = value;
      depth++;
      continue;
    }

    if (node.type === 'array' && typeof seg === 'number') {
      const idx = arrayIndex(node, seg);
      const kids = childrenOf(node);
      const kid = kids[idx];
      if (!kid) break;
      parent = node;
      unit = kid;
      node = kid;
      depth++;
      continue;
    }

    break;
  }

  return parent === undefined ? { node, depth, unit } : { node, depth, parent, unit };
}

export function setAtPath(text: string, segs: Seg[], value: unknown, style: EditStyle): string {
  const root = parseRoot(text);
  const hit = findDeepest(root, segs);

  if (hit.depth === segs.length) {
    return replaceNode(text, hit.node, value, style);
  }

  const rest = segs.slice(hit.depth);

  if (hit.node.type === 'object' && typeof rest[0] === 'string') {
    return insertProperty(text, hit.node, rest[0], buildValue(rest.slice(1), value), style);
  }
  if (hit.node.type === 'array' && typeof rest[0] === 'number') {
    return insertElement(text, hit.node, rest[0], buildValue(rest.slice(1), value), style);
  }
  return replaceNode(text, hit.node, buildValue(rest, value), style);
}

function insertProperty(
  text: string,
  obj: jsonc.Node,
  key: string,
  value: unknown,
  style: EditStyle,
): string {
  const unit = indentUnit(style);
  const eol = style.eol;
  const open = obj.offset;
  const close = obj.offset + obj.length - 1;
  const basePad = leadingWhitespace(text, lineStartOf(text, open));
  const props = childrenOf(obj);
  const inline = !text.slice(open, close + 1).includes('\n');

  const rendered = serializeValue(value, style, basePad + unit);
  const property = `${JSON.stringify(key)}: ${rendered}`;

  if (props.length > 0) {
    const last = props[props.length - 1]!;
    const at = last.offset + last.length;
    const separator = inline ? ', ' : `,${eol}${basePad}${unit}`;
    return text.slice(0, at) + separator + property + text.slice(at);
  }

  const closeLineStart = lineStartOf(text, close);
  const closePrefix = text.slice(closeLineStart, close);
  if (/^[ \t]*$/.test(closePrefix)) {
    return text.slice(0, closeLineStart) + `${basePad}${unit}${property}${eol}` + text.slice(closeLineStart);
  }
  return text.slice(0, open + 1) + `${eol}${basePad}${unit}${property}${eol}${basePad}` + text.slice(open + 1);
}

function insertElement(
  text: string,
  arr: jsonc.Node,
  seg: number,
  value: unknown,
  style: EditStyle,
): string {
  const unit = indentUnit(style);
  const eol = style.eol;
  const open = arr.offset;
  const close = arr.offset + arr.length - 1;
  const basePad = leadingWhitespace(text, lineStartOf(text, open));
  const kids = childrenOf(arr);
  const len = kids.length;
  const idx = seg < 0 ? len + seg : seg;
  if (idx < 0 || idx > len) throw new EditError(`index ${seg} is out of range (length ${len})`);

  const inline = !text.slice(open, close + 1).includes('\n');
  const rendered = serializeValue(value, style, basePad + unit);
  const separator = inline ? ', ' : `,${eol}${basePad}${unit}`;

  if (len === 0) {
    const closeLineStart = lineStartOf(text, close);
    const closePrefix = text.slice(closeLineStart, close);
    if (/^[ \t]*$/.test(closePrefix)) {
      return text.slice(0, closeLineStart) + `${basePad}${unit}${rendered}${eol}` + text.slice(closeLineStart);
    }
    return text.slice(0, open + 1) + `${eol}${basePad}${unit}${rendered}${eol}${basePad}` + text.slice(open + 1);
  }

  if (idx === len) {
    const last = kids[len - 1]!;
    const at = last.offset + last.length;
    return text.slice(0, at) + separator + rendered + text.slice(at);
  }

  const target = kids[idx]!;
  return text.slice(0, target.offset) + rendered + separator + text.slice(target.offset);
}

function findComma(text: string, from: number, limit: number): number {
  const end = Math.min(limit, text.length);
  for (let i = from; i < end; i++) {
    const c = text[i];
    if (c === ',') return i;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return -1;
  }
  return -1;
}

export function deleteAtPath(text: string, segs: Seg[]): string {
  const root = parseRoot(text);
  if (segs.length === 0) throw new EditError('cannot delete the document root');
  const hit = findDeepest(root, segs);
  if (hit.depth !== segs.length || hit.parent === undefined) throw new EditError('path not found');

  const container = hit.parent;
  const unit = hit.unit;
  const siblings = childrenOf(container);
  const idx = siblings.indexOf(unit);
  const start = unit.offset;
  const end = unit.offset + unit.length;
  const lineStart = lineStartOf(text, start);
  const lineEnd = lineEndOf(text, end);
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  const aloneOnLine =
    /^[ \t]*$/.test(before) && /^[ \t]*,?[ \t]*(\/\/[^\n]*|\/\*[^\n]*\*\/)?[ \t]*$/.test(after);
  const isLast = idx === siblings.length - 1;

  if (aloneOnLine) {
    let delStart = lineStart;
    let delEnd = lineEnd < text.length ? lineEnd + 1 : lineEnd;
    if (isLast && idx > 0) {
      let p = lineStart - 1;
      while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n' || text[p] === '\r')) p--;
      if (text[p] === ',') {
        // also swallow the comma that used to separate us from the sibling above,
        // but keep the line break in front of the closing bracket
        delStart = p;
        delEnd = lineEnd;
      }
    }
    return text.slice(0, delStart) + text.slice(delEnd);
  }

  const commaAfter = findComma(text, end, lineEnd + 1);
  if (commaAfter !== -1 && !isLast) {
    let delEnd = commaAfter + 1;
    while (text[delEnd] === ' ' || text[delEnd] === '\t') delEnd++;
    return text.slice(0, start) + text.slice(delEnd);
  }

  if (idx > 0) {
    const prev = siblings[idx - 1]!;
    const commaBefore = findComma(text, prev.offset + prev.length, start + 1);
    if (commaBefore !== -1) return text.slice(0, commaBefore) + text.slice(end);
  }

  return text.slice(0, start) + text.slice(end);
}
