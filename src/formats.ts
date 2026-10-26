import * as jsonc from 'jsonc-parser';
import JSON5 from 'json5';

export type Format = 'json' | 'jsonc' | 'json5' | 'ndjson';

export const FORMATS: readonly Format[] = ['json', 'jsonc', 'json5', 'ndjson'];

export function isFormat(x: string): x is Format {
  return (FORMATS as readonly string[]).includes(x);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface ParseIssue {
  message: string;
  offset: number;
  length: number;
}

export class FormatError extends Error {
  readonly issues: ParseIssue[];
  readonly format: Format;

  constructor(format: Format, issues: ParseIssue[]) {
    super(issues[0]?.message ?? 'parse error');
    this.name = 'FormatError';
    this.format = format;
    this.issues = issues;
  }
}

/** 1-based line/column for a character offset. */
export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

const JSONC_OPTIONS: jsonc.ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: false,
};

function tryStrictJson(text: string): { ok: true } | { ok: false; error: unknown } {
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function isStrictJson(text: string): boolean {
  return tryStrictJson(text).ok;
}

export function jsoncErrors(text: string): jsonc.ParseError[] {
  const errors: jsonc.ParseError[] = [];
  jsonc.parse(text, errors, JSONC_OPTIONS);
  return errors;
}

export function isJsonc(text: string): boolean {
  return jsoncErrors(text).length === 0;
}

export function ndjsonLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

export function isNdjson(text: string): boolean {
  const lines = ndjsonLines(text);
  if (lines.length < 2) return false;
  return lines.every((line) => {
    if (tryStrictJson(line).ok) return true;
    try {
      JSON5.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

/** Guess the format of a document. Throws FormatError when nothing matches. */
export function detect(text: string): Format {
  const t = stripBom(text);
  if (t.trim() === '') {
    throw new FormatError('json', [{ message: 'empty input', offset: 0, length: 0 }]);
  }
  if (tryStrictJson(t).ok) return 'json';
  if (isNdjson(t)) return 'ndjson';
  const errors = jsoncErrors(t);
  if (errors.length === 0) return 'jsonc';
  try {
    JSON5.parse(t);
    return 'json5';
  } catch {
    // fall through to the most informative failure we have
  }
  const first = errors[0];
  const issue: ParseIssue = first
    ? {
        message: jsonc.printParseErrorCode(first.error) || 'invalid JSON',
        offset: first.offset,
        length: first.length,
      }
    : { message: 'invalid JSON', offset: 0, length: 0 };
  throw new FormatError('jsonc', [issue]);
}

function json5Issues(text: string, error: unknown): ParseIssue[] {
  const raw = error instanceof Error ? error.message : String(error);
  const m = /at (\d+):(\d+)/.exec(raw);
  if (!m) return [{ message: raw, offset: 0, length: 0 }];
  const line = Number(m[1]);
  const column = Number(m[2]);
  let offset = 0;
  let curLine = 1;
  while (curLine < line && offset < text.length) {
    if (text[offset] === '\n') curLine++;
    offset++;
  }
  offset += Math.max(0, column - 1);
  return [{ message: raw.replace(/^JSON5:\s*/, ''), offset: Math.min(offset, text.length), length: 1 }];
}

/** Parse every top-level value in the document. Always returns at least one value. */
export function parseValues(text: string, format: Format): unknown[] {
  const t = stripBom(text);
  switch (format) {
    case 'json': {
      try {
        return [JSON.parse(t)];
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        const pos = /position (\d+)/.exec(raw);
        const offset = pos?.[1] ? Number(pos[1]) : 0;
        throw new FormatError('json', [{ message: raw, offset, length: 1 }]);
      }
    }
    case 'jsonc': {
      const errors: jsonc.ParseError[] = [];
      const value = jsonc.parse(t, errors, JSONC_OPTIONS);
      if (errors.length > 0) {
        throw new FormatError(
          'jsonc',
          errors.map((e) => ({
            message: jsonc.printParseErrorCode(e.error) || 'invalid JSONC',
            offset: e.offset,
            length: e.length,
          })),
        );
      }
      return [value];
    }
    case 'json5': {
      try {
        return [JSON5.parse(t)];
      } catch (error) {
        throw new FormatError('json5', json5Issues(t, error));
      }
    }
    case 'ndjson': {
      return ndjsonLines(t).map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          try {
            return JSON5.parse(line);
          } catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            throw new FormatError('ndjson', [{ message: `line ${index + 1}: ${raw}`, offset: 0, length: 0 }]);
          }
        }
      });
    }
  }
}

/** Parse a document into a single value. Rejects documents holding several values. */
export function parseOne(text: string, format: Format): unknown {
  const values = parseValues(text, format);
  if (values.length > 1) {
    throw new FormatError(format, [
      { message: `expected a single value, found ${values.length} (NDJSON?)`, offset: 0, length: 0 },
    ]);
  }
  return values[0];
}

export function validate(text: string, format: Format): ParseIssue[] {
  try {
    parseValues(text, format);
    return [];
  } catch (error) {
    if (error instanceof FormatError) return error.issues;
    throw error;
  }
}
