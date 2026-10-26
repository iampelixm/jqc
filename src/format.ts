import { SyntaxKind, createScanner } from 'jsonc-parser';
import { type EditStyle, indentUnit } from './style.ts';

export type FormatMode = 'preserve' | 'canonical';

interface Tok {
  kind: number;
  start: number;
  len: number;
}

function tokenize(text: string): Tok[] {
  const scanner = createScanner(text, false);
  const out: Tok[] = [];
  for (;;) {
    const kind = scanner.scan();
    if (kind === SyntaxKind.EOF) break;
    out.push({ kind, start: scanner.getTokenOffset(), len: scanner.getTokenLength() });
  }
  return out;
}

function isTrivia(kind: number): boolean {
  return (
    kind === SyntaxKind.Trivia ||
    kind === SyntaxKind.LineBreakTrivia ||
    kind === SyntaxKind.LineCommentTrivia ||
    kind === SyntaxKind.BlockCommentTrivia
  );
}

/** True when a `//` comment follows on the same line, e.g. `"a": 1, // note`. */
function lineCommentFollows(toks: Tok[], idx: number): boolean {
  for (let k = idx + 1; k < toks.length; k++) {
    const kind = toks[k]!.kind;
    if (kind === SyntaxKind.Trivia) continue;
    if (kind === SyntaxKind.LineBreakTrivia) return false;
    return kind === SyntaxKind.LineCommentTrivia;
  }
  return false;
}

const INLINE_WIDTH = 60;

/**
 * Re-indent a document without inventing structure.
 *
 * `preserve` (default) keeps every container on the lines the author put it on,
 * so short arrays stay short. `canonical` collapses containers narrower than
 * 60 chars and expands the rest.
 *
 * Comments are copied verbatim and keep their attachment to the line they were
 * written on.
 */
export function formatDocument(text: string, style: EditStyle, mode: FormatMode = 'preserve'): string {
  const toks = tokenize(text);
  const slice = (t: Tok): string => text.slice(t.start, t.start + t.len);
  const eol = style.eol;
  const unit = indentUnit(style);

  // pair up brackets so we can judge each container as a whole
  const match = new Map<number, number>();
  const openStack: number[] = [];
  toks.forEach((t, idx) => {
    if (t.kind === SyntaxKind.OpenBraceToken || t.kind === SyntaxKind.OpenBracketToken) {
      openStack.push(idx);
    } else if (t.kind === SyntaxKind.CloseBraceToken || t.kind === SyntaxKind.CloseBracketToken) {
      const opened = openStack.pop();
      if (opened !== undefined) match.set(opened, idx);
    }
  });

  const multiline = new Map<number, boolean>();
  for (const [openIdx, closeIdx] of match) {
    let empty = true;
    let hasBreak = false;
    let hasComment = false;
    for (let k = openIdx + 1; k < closeIdx; k++) {
      const kind = toks[k]!.kind;
      if (kind === SyntaxKind.LineBreakTrivia) hasBreak = true;
      else if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) hasComment = true;
      if (!isTrivia(kind)) empty = false;
    }
    if (empty && !hasComment) {
      multiline.set(openIdx, false);
      continue;
    }
    const width = toks[closeIdx]!.start + toks[closeIdx]!.len - toks[openIdx]!.start;
    multiline.set(openIdx, mode === 'canonical' ? hasComment || width > INLINE_WIDTH : hasBreak);
  }

  const out: string[] = [];
  const stack: { ml: boolean }[] = [];
  let depth = 0;
  let lineStart = true;
  let breaks = 0;
  let spaceBefore = false;

  const write = (s: string): void => {
    out.push(s);
    lineStart = false;
  };
  const writeIndent = (): void => {
    if (!lineStart) return;
    if (depth > 0) out.push(unit.repeat(depth));
    lineStart = false;
  };
  const newline = (): void => {
    if (lineStart) return;
    while (out.length > 0 && (out[out.length - 1] === ' ' || out[out.length - 1] === '\t')) out.pop();
    out.push(eol);
    lineStart = true;
  };
  const blankLine = (): void => {
    out.push(eol);
  };

  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx]!;
    const kind = t.kind;
    const ctx = stack[stack.length - 1];

    if (kind === SyntaxKind.Trivia) continue;
    if (kind === SyntaxKind.LineBreakTrivia) {
      breaks++;
      continue;
    }

    if (kind === SyntaxKind.LineCommentTrivia) {
      if (lineStart) writeIndent();
      else write(' ');
      write(slice(t));
      newline();
      breaks = 0;
      spaceBefore = false;
      continue;
    }

    if (kind === SyntaxKind.BlockCommentTrivia) {
      if (lineStart) {
        if (breaks >= 2) blankLine();
        writeIndent();
      } else if (spaceBefore) {
        write(' ');
      } else {
        write(' ');
      }
      write(slice(t));
      if (breaks > 0) newline();
      breaks = 0;
      spaceBefore = true;
      continue;
    }

    if (kind === SyntaxKind.OpenBraceToken || kind === SyntaxKind.OpenBracketToken) {
      if (lineStart) {
        if (breaks >= 2) blankLine();
        writeIndent();
      } else if (spaceBefore) {
        write(' ');
      }
      write(slice(t));
      const ml = multiline.get(idx) ?? false;
      stack.push({ ml });
      if (ml) {
        depth++;
        newline();
      }
      breaks = 0;
      spaceBefore = false;
      continue;
    }

    if (kind === SyntaxKind.CloseBraceToken || kind === SyntaxKind.CloseBracketToken) {
      const closed = stack.pop();
      if (closed?.ml) {
        depth--;
        newline();
        writeIndent();
      }
      write(slice(t));
      breaks = 0;
      spaceBefore = false;
      continue;
    }

    if (kind === SyntaxKind.CommaToken) {
      write(',');
      const trailingComment = lineCommentFollows(toks, idx);
      if (ctx?.ml) {
        if (!trailingComment) newline();
      } else {
        write(' ');
      }
      breaks = 0;
      spaceBefore = false;
      continue;
    }

    if (kind === SyntaxKind.ColonToken) {
      write(': ');
      breaks = 0;
      spaceBefore = false;
      continue;
    }

    // property names and literals
    if (lineStart) {
      if (breaks >= 2) blankLine();
      writeIndent();
    } else if (spaceBefore) {
      write(' ');
    }
    write(slice(t));
    breaks = 0;
    spaceBefore = false;
  }

  let result = out.join('');
  result = result.replace(/[ \t]+(?=\r?\n)/g, '');
  while (result.endsWith(eol + eol)) result = result.slice(0, -eol.length);
  if (!result.endsWith(eol)) result += eol;
  return result;
}
