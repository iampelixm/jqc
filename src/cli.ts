#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import {
  type Format,
  FormatError,
  isFormat,
  lineCol,
  type ParseIssue,
  validate,
} from './formats.ts';
import { EditError, deleteValue, detectStyle, setValue, styleFrom } from './edit.ts';
import { PathError, parsePath } from './path.ts';
import { UsageError, readStdin, runQuery, splitQueryArgs } from './jq.ts';
import {
  convertDoc,
  diffDocs,
  formatDoc,
  lookup,
  mergeDocs,
  renderDiff,
  resolveFormat,
  validateDoc,
} from './ops.ts';

const VERSION = '0.1.0';

const HELP = `jqc ${VERSION} — jq for JSONC/JSON5 configs

USAGE
  jqc '<jq program>' [file...]      query: every jq flag works, comments are tolerated
  jqc set <path> <value> [file]     edit a value, keep comments and formatting
  jqc get <path> [file]             read a value by path
  jqc del <path> [file]             remove a value
  jqc validate [file...]            check syntax, report line:column
  jqc fmt [file]                    re-indent, optionally sort keys
  jqc convert [file] --to <format>  json | jsonc | json5 | ndjson
  jqc merge <base> <overlay>        deep merge, keeps comments from base
  jqc diff <a> <b>                  structural diff, formatting ignored

QUERY MODE
  Any argument that is not a subcommand is passed to real jq:
    jqc .scripts.build tsconfig.json
    jqc -r '.deps[]' package.json
    jqc --arg env prod '.env == $env' config.jsonc
  Input is auto-detected (json/jsonc/json5/ndjson) and normalized for jq
  without shifting error positions. Use \`jqc -- get ...\` if a jq program
  happens to be named like a subcommand.

EDIT MODE
  Paths: a.b[0].c, $.a.b, a["key with spaces"], a[-1] (last element)
  Value is parsed as JSON when possible, otherwise kept as a string.
  Default output is stdout; add -w to rewrite the file in place.

OPTIONS
  -w, --write            write result back to the file
  --indent <n|tab>       indentation for edits/formatting (default: detected)
  --in-fmt <fmt>         force input format instead of auto-detect
  --to <fmt>             target format for convert
  --sort-keys            sort object keys (fmt; drops comments)
  --check                exit 1 if formatting would change anything
  --arrays replace|concat   array merge strategy (default: replace)
  -r, --raw              get: print strings without quotes
  -c, --compact          get: single-line output
  --string, --json       set: force string / require valid JSON
  --exit-code            diff: exit 1 when documents differ
  --no-normalize         query: pass input to jq untouched
  --jq-bin <path>        query: use another jq binary (default: jq)
  -h, --help             this text
  --version              print version
`;

type Kind = 'bool' | 'value';
type Spec = Record<string, Kind>;
interface Parsed {
  opts: Record<string, string | true>;
  positional: string[];
}

function parseArgs(argv: string[], spec: Spec): Parsed {
  const opts: Record<string, string | true> = {};
  const positional: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const kind = spec[name];
      if (kind === undefined) throw new UsageError(`unknown option ${name}`);
      if (kind === 'bool') {
        if (inline !== undefined) throw new UsageError(`${name} does not take a value`);
        opts[name] = true;
      } else if (inline !== undefined) {
        opts[name] = inline;
      } else {
        const v = argv[i + 1];
        if (v === undefined) throw new UsageError(`${name} needs a value`);
        opts[name] = v;
        i++;
      }
      i++;
      continue;
    }

    if (arg.length > 1 && arg[0] === '-' && arg !== '-') {
      const name = `-${arg[1]!}`;
      const kind = spec[name];
      if (kind === undefined) throw new UsageError(`unknown option ${name}`);
      if (kind === 'bool') {
        if (arg.length > 2) throw new UsageError(`option clusters are not supported: ${arg}`);
        opts[name] = true;
        i++;
        continue;
      }
      const rest = arg.slice(2);
      if (rest !== '') {
        opts[name] = rest;
      } else {
        const v = argv[i + 1];
        if (v === undefined) throw new UsageError(`${name} needs a value`);
        opts[name] = v;
        i++;
      }
      i++;
      continue;
    }

    positional.push(arg);
    i++;
  }

  return { opts, positional };
}

function flag(opts: Parsed['opts'], ...names: string[]): boolean {
  return names.some((n) => opts[n] === true);
}

function option(opts: Parsed['opts'], ...names: string[]): string | undefined {
  for (const n of names) {
    const v = opts[n];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function requestedFormat(opts: Parsed['opts']): Format | 'auto' {
  const v = option(opts, '--in-fmt', '--format') ?? option(opts, '-f');
  if (v === undefined) return 'auto';
  if (v === 'auto') return 'auto';
  if (!isFormat(v)) throw new UsageError(`unknown format "${v}" (expected auto|json|jsonc|json5|ndjson)`);
  return v;
}

function indentOption(opts: Parsed['opts']): string | number | undefined {
  const v = option(opts, '--indent');
  if (v === undefined) return undefined;
  return /^\d+$/.test(v) ? Number(v) : v;
}

async function readInput(arg: string | undefined): Promise<{ text: string; name: string }> {
  if (arg === undefined || arg === '-') {
    if (process.stdin.isTTY) throw new UsageError('no input: pass a file name or pipe data to stdin');
    return { text: await readStdin(), name: '<stdin>' };
  }
  return { text: await readFile(arg, 'utf8'), name: arg };
}

async function emit(text: string, file: string | undefined, write: boolean): Promise<void> {
  if (write) {
    if (file === undefined || file === '-') throw new UsageError('--write needs a real file name');
    await writeFile(file, text, 'utf8');
  } else {
    process.stdout.write(text);
  }
}

function fail(message: string): number {
  process.stderr.write(`jqc: ${message}\n`);
  return 1;
}

function printIssues(issues: ParseIssue[], text: string, name: string): void {
  for (const issue of issues.slice(0, 10)) {
    const { line, column } = lineCol(text, issue.offset);
    process.stderr.write(`${name}:${line}:${column}: ${issue.message}\n`);
  }
}

/** Parse errors get line:column; return null when the document is fine. */
function checkParse(text: string, fmt: Format, name: string): number | null {
  const issues = validate(text, fmt);
  if (issues.length === 0) return null;
  printIssues(issues, text, name);
  return 1;
}

function formatValue(value: unknown, raw: boolean, compact: boolean): string {
  if (raw && typeof value === 'string') return `${value}\n`;
  if (compact) return `${JSON.stringify(value) ?? 'null'}\n`;
  return `${JSON.stringify(value, null, 2) ?? 'null'}\n`;
}

function parseValueArg(raw: string, opts: Parsed['opts']): unknown {
  if (flag(opts, '--string')) return raw;
  if (flag(opts, '--json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`--json value is not valid JSON: ${raw}`);
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function cmdGet(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '-r': 'bool',
    '--raw': 'bool',
    '-c': 'bool',
    '--compact': 'bool',
    '--in-fmt': 'value',
    '--format': 'value',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc get <path> [file] [-r] [-c]\n');
    return 0;
  }
  const [pathArg, fileArg] = positional;
  if (pathArg === undefined) throw new UsageError('get needs a path, e.g. jqc get .scripts.build tsconfig.json');

  const { text, name } = await readInput(fileArg);
  const fmt = resolveFormat(text, requestedFormat(opts));
  const bad = checkParse(text, fmt, name);
  if (bad !== null) return bad;

  const result = lookup(text, fmt, parsePath(pathArg));
  if (!result.found) return fail(`${name}: ${pathArg} not found`);

  process.stdout.write(formatValue(result.value, flag(opts, '-r', '--raw'), flag(opts, '-c', '--compact')));
  return 0;
}

async function cmdSet(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '-w': 'bool',
    '--write': 'bool',
    '--value': 'value',
    '--indent': 'value',
    '--in-fmt': 'value',
    '--format': 'value',
    '--string': 'bool',
    '--json': 'bool',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc set <path> <value> [file] [-w]\n       jqc set <path> --value <value> [file]\n');
    return 0;
  }

  const pathArg = positional[0];
  if (pathArg === undefined) throw new UsageError('set needs a path');

  const inlineValue = option(opts, '--value');
  const rawValue = inlineValue ?? positional[1];
  if (rawValue === undefined) throw new UsageError('set needs a value');
  const fileArg = inlineValue !== undefined ? positional[1] : positional[2];

  const { text, name } = await readInput(fileArg);
  const fmt = resolveFormat(text, requestedFormat(opts));
  const bad = checkParse(text, fmt, name);
  if (bad !== null) return bad;

  const style = styleFrom(indentOption(opts), detectStyle(text));
  const value = parseValueArg(rawValue, opts);
  const next = setValue(text, fmt, parsePath(pathArg), value, style);
  await emit(next, fileArg, flag(opts, '-w', '--write'));
  return 0;
}

async function cmdDelete(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '-w': 'bool',
    '--write': 'bool',
    '--indent': 'value',
    '--in-fmt': 'value',
    '--format': 'value',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc del <path> [file] [-w]\n');
    return 0;
  }
  const [pathArg, fileArg] = positional;
  if (pathArg === undefined) throw new UsageError('del needs a path');

  const { text, name } = await readInput(fileArg);
  const fmt = resolveFormat(text, requestedFormat(opts));
  const bad = checkParse(text, fmt, name);
  if (bad !== null) return bad;

  const style = styleFrom(indentOption(opts), detectStyle(text));
  const next = deleteValue(text, fmt, parsePath(pathArg));
  await emit(next, fileArg, flag(opts, '-w', '--write'));
  return 0;
}

async function cmdValidate(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '--in-fmt': 'value',
    '--format': 'value',
    '-q': 'bool',
    '--quiet': 'bool',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc validate [file...]\n');
    return 0;
  }

  const targets: (string | undefined)[] = positional.length > 0 ? positional : [undefined];
  let failed = false;

  for (const target of targets) {
    const { text, name } = await readInput(target);
    const result = validateDoc(text, requestedFormat(opts));
    if (result.issues.length === 0) {
      if (!flag(opts, '-q', '--quiet')) process.stdout.write(`${name}: OK (${result.format})\n`);
      continue;
    }
    failed = true;
    printIssues(result.issues, text, name);
  }

  return failed ? 1 : 0;
}

async function cmdFormat(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '-w': 'bool',
    '--write': 'bool',
    '--indent': 'value',
    '--in-fmt': 'value',
    '--format': 'value',
    '--sort-keys': 'bool',
    '--check': 'bool',
    '--canonical': 'bool',
    '--keep-lines': 'bool',
    '-q': 'bool',
    '--quiet': 'bool',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc fmt [file] [-w] [--indent 2|tab] [--sort-keys] [--check]\n');
    return 0;
  }

  const fileArg = positional[0];
  const { text, name } = await readInput(fileArg);
  const fmt = resolveFormat(text, requestedFormat(opts));
  const style = styleFrom(indentOption(opts), detectStyle(text));
  const result = formatDoc(text, fmt, style, {
    sortKeys: flag(opts, '--sort-keys'),
    canonical: !flag(opts, '--keep-lines'),
  });

  if (flag(opts, '--check')) {
    if (result.text === text) return 0;
    process.stderr.write(`jqc: ${name} is not formatted\n`);
    return 1;
  }

  if (result.commentsLost && !flag(opts, '-q', '--quiet')) {
    process.stderr.write('jqc: note: --sort-keys rebuilds the document, comments are dropped\n');
  }
  await emit(result.text, fileArg, flag(opts, '-w', '--write'));
  return 0;
}

async function cmdConvert(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '--to': 'value',
    '-t': 'value',
    '-w': 'bool',
    '--write': 'bool',
    '--indent': 'value',
    '--in-fmt': 'value',
    '--format': 'value',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc convert [file] --to json|jsonc|json5|ndjson\n');
    return 0;
  }

  const to = option(opts, '--to', '-t');
  if (to === undefined) throw new UsageError('convert needs --to <json|jsonc|json5|ndjson>');
  if (!isFormat(to)) throw new UsageError(`unknown target format "${to}"`);

  const fileArg = positional[0];
  const { text } = await readInput(fileArg);
  const style = styleFrom(indentOption(opts), detectStyle(text));
  const next = convertDoc(text, requestedFormat(opts), to, style);
  await emit(next, fileArg, flag(opts, '-w', '--write'));
  return 0;
}

async function cmdMerge(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '-w': 'bool',
    '--write': 'bool',
    '--indent': 'value',
    '--in-fmt': 'value',
    '--format': 'value',
    '--arrays': 'value',
    '-v': 'bool',
    '--verbose': 'bool',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc merge <base> <overlay> [-w] [--arrays replace|concat]\n');
    return 0;
  }

  const [baseArg, overlayArg] = positional;
  if (baseArg === undefined || overlayArg === undefined) {
    throw new UsageError('merge needs two files: base and overlay');
  }
  const arrays = option(opts, '--arrays') ?? 'replace';
  if (arrays !== 'replace' && arrays !== 'concat') throw new UsageError(`bad --arrays value "${arrays}"`);

  const base = await readInput(baseArg);
  const overlay = await readInput(overlayArg);
  const style = styleFrom(indentOption(opts), detectStyle(base.text));
  const result = mergeDocs(base.text, requestedFormat(opts), overlay.text, requestedFormat(opts), style, {
    arrays,
  });

  if (flag(opts, '-v', '--verbose')) {
    process.stderr.write(`jqc: ${result.changes} change(s) applied to ${base.name}\n`);
  }
  await emit(result.text, baseArg === '-' ? undefined : baseArg, flag(opts, '-w', '--write'));
  return 0;
}

async function cmdDiff(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv, {
    '--exit-code': 'bool',
    '--in-fmt': 'value',
    '--format': 'value',
    '-h': 'bool',
    '--help': 'bool',
  });
  if (flag(opts, '-h', '--help')) {
    process.stdout.write('usage: jqc diff <a> <b> [--exit-code]\n');
    return 0;
  }

  const [aArg, bArg] = positional;
  if (aArg === undefined || bArg === undefined) throw new UsageError('diff needs two files');
  const a = await readInput(aArg);
  const b = await readInput(bArg);
  const entries = diffDocs(a.text, requestedFormat(opts), b.text, requestedFormat(opts));

  if (entries.length > 0) {
    process.stdout.write(`${renderDiff(entries)}\n`);
    if (flag(opts, '--exit-code')) return 1;
  }
  return 0;
}

const SUBCOMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  get: cmdGet,
  set: cmdSet,
  del: cmdDelete,
  rm: cmdDelete,
  unset: cmdDelete,
  validate: cmdValidate,
  check: cmdValidate,
  fmt: cmdFormat,
  format: cmdFormat,
  convert: cmdConvert,
  merge: cmdMerge,
  diff: cmdDiff,
};

async function main(argv: string[]): Promise<number> {
  const first = argv[0];

  if (first === undefined) {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === '--version' || first === '-V' || first === 'version') {
    process.stdout.write(`jqc ${VERSION}\n`);
    return 0;
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const command = SUBCOMMANDS[first];
  if (command !== undefined) return await command(argv.slice(1));

  return await runQuery(splitQueryArgs(argv));
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof FormatError) {
      for (const issue of error.issues.slice(0, 10)) {
        process.stderr.write(`jqc: ${issue.message}\n`);
      }
      process.exitCode = 1;
      return;
    }
    if (error instanceof UsageError || error instanceof PathError || error instanceof EditError) {
      process.stderr.write(`jqc: ${error.message}\n`);
      if (error instanceof UsageError) process.stderr.write('jqc: run `jqc --help` for usage\n');
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
