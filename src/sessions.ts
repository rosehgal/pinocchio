// Session-log reader for Claude Code and Codex. Turns both formats into one
// chronological list of events. Knows nothing about claims or verdicts, so other
// tools can reuse it as is.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export type Harness = 'claude' | 'codex';

export type Event =
  | { kind: 'user'; ts: number; text: string } // a prompt typed by the human
  | { kind: 'say'; ts: number; text: string } // text the agent showed the human
  | { kind: 'run'; ts: number; cmd: string; exit: number | null; output: string } // shell command; exit null = unknown
  | { kind: 'edit'; ts: number; path: string; added: string[] }; // file edit through an edit tool

export interface Session {
  harness: Harness;
  id: string;
  file: string;
  cwd: string;
  events: Event[];
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');

function logsUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Claude Code and Codex session logs modified at or after `since` (epoch ms). */
export function sessionFiles(since = 0): string[] {
  return [...logsUnder(join(claudeHome(), 'projects')), ...logsUnder(join(codexHome(), 'sessions'))].filter(
    (f) => statSync(f).mtimeMs >= since,
  );
}

export function readSession(file: string): Session | null {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
    if (file.endsWith('.zst')) buf = zstdDecompressSync(buf);
  } catch {
    return null;
  }
  return basename(file).startsWith('rollout-') ? parseCodex(buf.toString('utf8'), file) : parseClaude(buf.toString('utf8'), file);
}

const blockText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join('\n') : '';

function addedLines(before: string, after: string): string[] {
  const old = new Set(before.split('\n'));
  return after.split('\n').filter((l) => !old.has(l));
}

// Large outputs are moved to a side file and replaced by a 2KB preview.
const fullOutput = (out: string) => readOr(/^<persisted-output>\s*Output too large[^\n]*saved to: (\S+)/.exec(out)?.[1], out);

const readOr = (path: string | undefined, fallback: string) => {
  try {
    return path ? readFileSync(path, 'utf8') : fallback;
  } catch {
    return fallback;
  }
};

function parseClaude(text: string, file: string): Session {
  const s: Session = { harness: 'claude', id: basename(file, '.jsonl'), file, cwd: '', events: [] };
  const pending = new Map<string, any>();
  const background = new Map<string, string>(); // task id -> command; the result arrives later as a task notification
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"queued_command"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(o.timestamp);
    if (o.type === 'attachment' && o.attachment?.type === 'queued_command') {
      s.events.push({ kind: 'user', ts, text: blockText(o.attachment.prompt) });
      continue;
    }
    if (o.type !== 'assistant' && o.type !== 'user') continue;
    s.cwd ||= o.cwd ?? '';
    const content = o.message?.content;
    if (o.type === 'assistant') {
      if (o.message?.model === '<synthetic>' || !Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type === 'text' && b.text) s.events.push({ kind: 'say', ts, text: b.text });
        else if (b.type === 'tool_use') pending.set(b.id, b);
      }
      continue;
    }
    const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
    const isPrompt = !o.isMeta && !o.isCompactSummary && !blocks.some((b) => b.type === 'tool_result');
    for (const b of blocks) {
      if (b.type === 'text' && isPrompt && !b.text.startsWith('<')) s.events.push({ kind: 'user', ts, text: b.text });
      const done = b.type === 'text' && /<task-id>(\w+)<\/task-id>[\s\S]*?(?:<output-file>([^<]+)<\/output-file>)?[\s\S]*?<status>(\w+)<\/status>(?:[\s\S]*?\(exit code (\d+)\))?/.exec(b.text);
      if (done && background.has(done[1])) {
        const exit = done[4] != null ? Number(done[4]) : null;
        s.events.push({ kind: 'run', ts, cmd: background.get(done[1])!, exit, output: readOr(done[2], '') });
        background.delete(done[1]);
      }
      if (b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
      const use = pending.get(b.tool_use_id);
      pending.delete(b.tool_use_id);
      const input = use.input ?? {};
      if (use.name === 'Bash') {
        const out = blockText(b.content);
        const started = /^Command running in background with ID: (\w+)/.exec(out);
        if (started) {
          background.set(started[1], String(input.command ?? ''));
          continue;
        }
        const code = /^Exit code (\d+)/.exec(out);
        const r = o.toolUseResult;
        const unknown = input.run_in_background || r?.interrupted || r?.backgroundTaskId || (b.is_error && !code);
        const exit = unknown ? null : code ? Number(code[1]) : 0;
        s.events.push({ kind: 'run', ts, cmd: String(input.command ?? ''), exit, output: fullOutput(out) });
      } else if (!b.is_error) {
        const path = String(input.file_path ?? input.notebook_path ?? '');
        const added =
          use.name === 'Edit' ? addedLines(input.old_string ?? '', input.new_string ?? '')
          : use.name === 'MultiEdit' ? (input.edits ?? []).flatMap((e: any) => addedLines(e.old_string ?? '', e.new_string ?? ''))
          : use.name === 'Write' ? String(input.content ?? '').split('\n')
          : use.name === 'NotebookEdit' ? String(input.new_source ?? '').split('\n')
          : null;
        if (added) s.events.push({ kind: 'edit', ts, path, added });
      }
    }
  }
  return s;
}

// Codex Desktop copies Claude Code sessions into its own log; skip those copies.
let importedIds: Set<string> | undefined;
function imported(): Set<string> {
  if (!importedIds) {
    try {
      const j = JSON.parse(readFileSync(join(codexHome(), 'external_agent_session_imports.json'), 'utf8'));
      importedIds = new Set((j.records ?? []).map((r: any) => r.imported_thread_id));
    } catch {
      importedIds = new Set();
    }
  }
  return importedIds;
}

const SHELL_TOOLS = new Set(['shell', 'exec_command', 'shell_command', 'container.exec', 'local_shell']);

// ["/bin/zsh", "-lc", "npm test"] -> "npm test"
const script = (argv: unknown): string =>
  !Array.isArray(argv) ? String(argv ?? '')
  : /(?:^|\/)(?:ba|z|da)?sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1] ?? '') ? String(argv[2] ?? '')
  : argv.join(' ');

function patchEdits(patch: string, ts: number, cwd: string): Event[] {
  const edits: Extract<Event, { kind: 'edit' }>[] = [];
  for (const l of patch.split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(l);
    if (m) edits.push({ kind: 'edit', ts, path: resolve(cwd, m[1].trim()), added: [] });
    else if (l.startsWith('+') && edits.length) edits[edits.length - 1].added.push(l.slice(1));
  }
  return edits;
}

function parseCodex(text: string, file: string): Session | null {
  const s: Session = { harness: 'codex', id: basename(file).replace(/\.jsonl(\.zst)?$/, ''), file, cwd: '', events: [] };
  // Newer Codex logs every command and file change as a completed item; older logs only have the raw tool calls.
  const items = text.includes('"CommandExecution"') || text.includes('"FileChange"');
  const calls = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload ?? {};
    const ts = Date.parse(o.timestamp);
    if (o.type === 'session_meta') {
      if (imported().has(p.id)) return null;
      s.id = p.id ?? s.id;
      s.cwd ||= p.cwd ?? '';
    } else if (o.type === 'response_item' && p.type === 'message') {
      const t = (p.content ?? []).map((c: any) => c.text ?? '').join('\n');
      if (p.role === 'assistant' && t) s.events.push({ kind: 'say', ts, text: t });
      else if (p.role === 'user' && t && !/^\s*[<#]/.test(t)) s.events.push({ kind: 'user', ts, text: t });
    } else if (o.type === 'response_item' && !items) {
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name === 'apply_patch') {
        let patch = p.input ?? p.arguments ?? '';
        try {
          patch = JSON.parse(patch).input ?? patch;
        } catch {}
        s.events.push(...patchEdits(String(patch), ts, s.cwd));
      } else if (p.type === 'function_call' && SHELL_TOOLS.has(p.name)) {
        let args: any = {};
        try {
          args = JSON.parse(p.arguments);
        } catch {}
        calls.set(p.call_id, script(args.cmd ?? args.command));
      } else if (p.type === 'local_shell_call') {
        calls.set(p.call_id, script(p.action?.command));
      } else if (p.type === 'function_call_output' && calls.has(p.call_id)) {
        const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
        const code = /(?:Process exited with code|Exit code:?)\s*(-?\d+)|"exit_code":\s*(-?\d+)/.exec(out);
        s.events.push({ kind: 'run', ts, cmd: calls.get(p.call_id)!, exit: code ? Number(code[1] ?? code[2]) : null, output: out });
      }
    } else if (o.type === 'event_msg' && p.type === 'item_completed') {
      const it = p.item ?? {};
      if (it.type === 'CommandExecution') {
        s.events.push({ kind: 'run', ts, cmd: script(it.command), exit: it.exit_code ?? null, output: it.aggregated_output ?? '' });
      } else if (it.type === 'FileChange') {
        for (const [path, ch] of Object.entries<any>(it.changes ?? {})) {
          const added = ch.content != null ? String(ch.content).split('\n')
            : String(ch.unified_diff ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
          s.events.push({ kind: 'edit', ts, path: resolve(s.cwd, path), added });
        }
      }
    }
  }
  return s;
}
