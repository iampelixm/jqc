import JSON5 from 'json5';
import { type Format, detect, ndjsonLines, stripBom } from './formats.ts';

/**
 * Replace `//` and `/* *\/` comments with spaces, keeping every other character
 * in place. Line/column positions therefore survive, which matters because jq
 * reports errors by line.
 *
 * Comment markers inside string literals are left alone.
 */
export function blankComments(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;

  const copyString = (quote: string): void => {
    out.push(quote);
    i++;
    while (i < n) {
      const c = text[i]!;
      if (c === '\\') {
        out.push(c, text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (c === quote) {
        out.push(c);
        i++;
        return;
      }
      out.push(c);
      i++;
    }
  };

  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === '"' || c === "'") {
      copyString(c);
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      out.push('  ');
      i += 2;
      let closed = false;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out.push('  ');
          i += 2;
          closed = true;
          break;
        }
        out.push(text[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (!closed) out.push('');
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join('');
}

/**
 * Replace trailing commas (`[1,2,]`, `{"a":1,}`) with spaces. JSONC allows
 * them, strict JSON does not. Offsets are preserved.
 */
export function blankTrailingCommas(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i]!;

    if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < n) {
        const d = text[i]!;
        if (d === '\\') {
          out.push(d, text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out.push(d);
        i++;
        if (d === c) break;
      }
      continue;
    }

    if (c === ',') {
      let j = i + 1;
      while (j < n) {
        const d = text[j]!;
        if (d !== ' ' && d !== '\t' && d !== '\n' && d !== '\r') break;
        j++;
      }
      if (text[j] === '}' || text[j] === ']') {
        out.push(' ');
        i++;
        continue;
      }
    }

    out.push(c);
    i++;
  }

  return out.join('');
}

/**
 * Turn a document into something jq can read as a stream of strict JSON values.
 *
 * - json   -> untouched
 * - jsonc  -> comments and trailing commas blanked out (positions preserved)
 * - json5  -> re-serialized (JSON5 has no lossless textual mapping to JSON)
 * - ndjson -> line by line
 */
export function toJqText(text: string, format: Format): string {
  const t = stripBom(text);
  switch (format) {
    case 'json':
      return t;
    case 'jsonc':
      return blankTrailingCommas(blankComments(t));
    case 'json5':
      return JSON.stringify(JSON5.parse(t));
    case 'ndjson':
      return ndjsonLines(t)
        .map((line) => toJqText(line, detect(line)))
        .join('\n');
  }
}

/** True when the document carries comments or other JSON5-only syntax. */
export function isNonStrict(text: string): boolean {
  try {
    return detect(text) !== 'json';
  } catch {
    return true;
  }
}
