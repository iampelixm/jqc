export type Seg = string | number;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

function readQuoted(src: string, start: number): { value: string; next: number } {
  const quote = src[start];
  if (quote !== '"' && quote !== "'") throw new PathError(`expected a quote at ${start} in ${src}`);
  let i = start + 1;
  let value = '';
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      const e = src[i + 1];
      switch (e) {
        case 'n':
          value += '\n';
          break;
        case 't':
          value += '\t';
          break;
        case 'r':
          value += '\r';
          break;
        case 'b':
          value += '\b';
          break;
        case 'f':
          value += '\f';
          break;
        case 'u': {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PathError(`bad \\u escape in ${src}`);
          value += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          value += e ?? '';
      }
      i += 2;
      continue;
    }
    if (c === quote) return { value, next: i + 1 };
    value += c;
    i++;
  }
  throw new PathError(`unterminated string in ${src}`);
}

function readIdent(src: string, start: number): { value: string; next: number } {
  let i = start;
  let value = '';
  while (i < src.length) {
    const c = src[i]!;
    if (c === '.' || c === '[' || c === ']') break;
    value += c;
    i++;
  }
  const trimmed = value.trim();
  if (trimmed === '') throw new PathError(`empty path segment in ${src}`);
  return { value: trimmed, next: i };
}

/**
 * Parse a plain path expression.
 *
 *   $.scripts.build        -> ['scripts', 'build']
 *   scripts.build          -> ['scripts', 'build']
 *   a.b[0].c               -> ['a', 'b', 0, 'c']
 *   deps[-1]               -> ['deps', -1]   (last element)
 *   config["a.b"]          -> ['config', 'a.b']
 *   config.'a b'           -> ['config', 'a b']
 *   $                      -> []             (document root)
 */
export function parsePath(input: string): Seg[] {
  const src = input.trim();
  if (src === '' || src === '$') return [];
  const segs: Seg[] = [];
  let i = 0;

  if (src[i] === '$') {
    i++;
    if (src[i] === '.' || src[i] === '[') {
      if (src[i] === '.') i++;
    }
  }

  while (i < src.length) {
    const c = src[i]!;

    if (c === '.') {
      i++;
      if (i >= src.length) throw new PathError(`trailing '.' in ${src}`);
      if (src[i] === '"' || src[i] === "'") {
        const r = readQuoted(src, i);
        segs.push(r.value);
        i = r.next;
      } else {
        const r = readIdent(src, i);
        segs.push(r.value);
        i = r.next;
      }
      continue;
    }

    if (c === '[') {
      i++;
      while (src[i] === ' ') i++;
      if (i >= src.length) throw new PathError(`unterminated '[' in ${src}`);
      if (src[i] === '"' || src[i] === "'") {
        const r = readQuoted(src, i);
        segs.push(r.value);
        i = r.next;
      } else {
        const close = src.indexOf(']', i);
        if (close === -1) throw new PathError(`unterminated '[' in ${src}`);
        const raw = src.slice(i, close).trim();
        if (!/^-?\d+$/.test(raw)) throw new PathError(`expected an index inside [], got "${raw}"`);
        segs.push(Number(raw));
        i = close;
      }
      while (src[i] === ' ') i++;
      if (src[i] !== ']') throw new PathError(`expected ']' in ${src}`);
      i++;
      continue;
    }

    if (src[i] === '"' || src[i] === "'") {
      const r = readQuoted(src, i);
      segs.push(r.value);
      i = r.next;
      continue;
    }

    const r = readIdent(src, i);
    segs.push(r.value);
    i = r.next;
  }

  if (segs.length === 0) throw new PathError(`empty path in ${src}`);
  return segs;
}

/** Render segments back into the canonical bracket form. */
export function formatPath(segs: Seg[]): string {
  if (segs.length === 0) return '$';
  let out = '$';
  for (const seg of segs) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}
