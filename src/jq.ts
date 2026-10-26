import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { type Format, detect, isFormat } from './formats.ts';
import { toJqText } from './normalize.ts';

export interface QueryInvocation {
  program: string | undefined;
  jqArgs: string[];
  files: string[];
  inFormat: Format | 'auto';
  normalize: boolean;
  jqBin: string;
}

const VALUE_OPTS = new Set([
  '--arg',
  '--argjson',
  '--slurpfile',
  '--rawfile',
  '--indent',
  '--from-file',
  '--library-path',
  '-f',
  '-L',
]);

function wantsValue(longName: string): number {
  if (longName === '--arg' || longName === '--argjson') return 2;
  if (longName === '--slurpfile' || longName === '--rawfile') return 2;
  return 1;
}

function shortOptionArity(arg: string): number {
  // -f prog.jq / -L dir, also trailing in clusters like -rnf
  if (arg.startsWith('-f') && arg.length > 2) return 0;
  if (arg.startsWith('-L') && arg.length > 2) return 0;
  if (/^-[a-zA-Z]+$/.test(arg)) {
    const last = arg[arg.length - 1];
    if (last === 'f' || last === 'L') return 1;
  }
  return 0;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Split argv into our own flags and a verbatim jq command line.
 * Flags before the program belong to jq; the first bare word is the program
 * (unless -f/--from-file already supplied it), and everything after is a file.
 */
export function splitQueryArgs(argv: string[]): QueryInvocation {
  const inv: QueryInvocation = {
    program: undefined,
    jqArgs: [],
    files: [],
    inFormat: 'auto',
    normalize: true,
    jqBin: process.env['JQC_JQ'] ?? 'jq',
  };

  let hasFromFile = false;
  let i = 0;

  const takeValue = (name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new UsageError(`${name} needs a value`);
    i += 1;
    return v;
  };

  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '--') {
      i++;
      if (inv.program === undefined && !hasFromFile && i < argv.length) {
        inv.program = argv[i]!;
        i++;
      }
      inv.files.push(...argv.slice(i));
      break;
    }

    // our own flags (they never collide with jq's names)
    if (arg === '--jsonc' || arg === '--json5' || arg === '--ndjson' || arg === '--json') {
      inv.inFormat = arg.slice(2) as Format;
      inv.normalize = true;
      i++;
      continue;
    }
    if (arg === '--in-fmt' || arg === '--format') {
      const v = takeValue(arg);
      if (v === 'auto') inv.inFormat = 'auto';
      else if (isFormat(v)) inv.inFormat = v;
      else throw new UsageError(`unknown format "${v}" (expected auto|json|jsonc|json5|ndjson)`);
      i++;
      continue;
    }
    if (arg.startsWith('--in-fmt=') || arg.startsWith('--format=')) {
      const v = arg.slice(arg.indexOf('=') + 1);
      if (v === 'auto') inv.inFormat = 'auto';
      else if (isFormat(v)) inv.inFormat = v;
      else throw new UsageError(`unknown format "${v}"`);
      i++;
      continue;
    }
    if (arg === '--no-normalize') {
      inv.normalize = false;
      i++;
      continue;
    }
    if (arg === '--jq-bin') {
      inv.jqBin = takeValue(arg);
      i++;
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      // jq's own flags: pass through untouched
      inv.jqArgs.push(arg);
      const long = arg.startsWith('--') ? arg.split('=')[0]! : arg;
      if (long === '--from-file' || long === '-f') hasFromFile = true;
      if (arg.startsWith('--') && arg.includes('=')) {
        i++;
        continue;
      }
      if (VALUE_OPTS.has(long)) {
        const n = wantsValue(long);
        for (let k = 0; k < n; k++) inv.jqArgs.push(takeValue(long));
        i++;
        continue;
      }
      if (!arg.startsWith('--')) {
        const n = shortOptionArity(arg);
        for (let k = 0; k < n; k++) inv.jqArgs.push(takeValue(arg));
      }
      i++;
      continue;
    }

    if (inv.program === undefined && !hasFromFile) {
      inv.program = arg;
      i++;
      continue;
    }
    inv.files.push(arg);
    i++;
  }

  if (inv.program === undefined && !hasFromFile) {
    throw new UsageError('no jq program given');
  }
  return inv;
}

export function isRawMode(jqArgs: string[]): boolean {
  return jqArgs.some((a) => {
    if (a === '--raw-input' || a === '--seq') return true;
    if (a.startsWith('--raw-input=') || a.startsWith('--seq=')) return true;
    if (/^-[a-zA-Z]+$/.test(a)) return a.includes('R');
    return false;
  });
}

/** Read the whole of stdin. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface InputPayload {
  text: string;
  piped: boolean;
}

/** Collect and normalize every input file into one JSON stream for jq. */
export async function buildPayload(inv: QueryInvocation): Promise<InputPayload> {
  const raw = !inv.normalize || isRawMode(inv.jqArgs);

  if (inv.files.length === 0) {
    if (process.stdin.isTTY) return { text: '', piped: false };
    const text = await readStdin();
    if (raw) return { text, piped: true };
    return { text: normalize(text, inv.inFormat), piped: true };
  }

  const parts: string[] = [];
  for (const file of inv.files) {
    const text = await readFile(file, 'utf8');
    parts.push(raw ? text : normalize(text, inv.inFormat));
  }
  return { text: parts.join('\n'), piped: true };
}

function normalize(text: string, fmt: Format | 'auto'): string {
  const format = fmt === 'auto' ? detect(text) : fmt;
  return toJqText(text, format);
}

export async function runQuery(inv: QueryInvocation): Promise<number> {
  const payload = await buildPayload(inv);
  const args = [...inv.jqArgs];
  if (inv.program !== undefined) args.push(inv.program);
  args.push('-');

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(inv.jqBin, args, {
      stdio: [payload.piped ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new UsageError(`cannot find "${inv.jqBin}" in PATH — jqc reuses real jq for queries`));
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => resolve(code ?? 0));

    if (!payload.piped || !child.stdin) return;

    child.stdin.on('error', () => {
      // jq may exit before we finish writing (e.g. `jq -n`)
    });
    child.stdin.end(payload.text);
  });
}
