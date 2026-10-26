export interface EditStyle {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
}

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/** Infer indentation and line endings from the document itself. */
export function detectStyle(text: string): EditStyle {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    const ws = m[1]!;
    if (ws.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
    return { insertSpaces: true, tabSize: ws.length, eol };
  }
  return { insertSpaces: true, tabSize: 2, eol };
}

export function styleFrom(indent: string | number | undefined, base: EditStyle): EditStyle {
  if (indent === undefined) return base;
  if (typeof indent === 'number') {
    if (!Number.isInteger(indent) || indent < 0 || indent > 8) throw new EditError(`bad indent: ${indent}`);
    return { ...base, insertSpaces: true, tabSize: indent };
  }
  if (indent === 'tab' || indent === '\t') return { ...base, insertSpaces: false, tabSize: 1 };
  if (/^\d+$/.test(indent)) return { ...base, insertSpaces: true, tabSize: Number(indent) };
  throw new EditError(`bad indent: ${indent}`);
}

export function indentUnit(style: EditStyle): string {
  return style.insertSpaces ? ' '.repeat(style.tabSize) : '\t';
}
