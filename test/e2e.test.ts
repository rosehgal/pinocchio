// End to end: fake Claude Code and Codex homes on disk, then the real CLI against them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { readSession } from '../src/sessions.ts';

const home = mkdtempSync(join(tmpdir(), 'pinocchio-test-'));
const repo = join(home, 'repo');
const claude = join(home, 'claude');
const codex = join(home, 'codex');
const at = (s: number) => new Date(Date.now() - 3_600_000 + s * 1000).toISOString();
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n');

mkdirSync(repo);
writeFileSync(join(repo, 'ledger.py'), 'total = round(total, 2)\n# TODO: handle currencies\n');

// Claude Code: an edit, a background pytest that fails, then "all tests pass".
const lie = join(claude, 'projects', '-repo', 'lie.jsonl');
mkdirSync(join(claude, 'projects', '-repo'), { recursive: true });
writeFileSync(join(home, 'bg1.output'), 'FAILED tests/test_ledger.py::test_split\n1 failed, 2 passed in 0.10s\n');
const assistant = (s: number, content: object[]) => ({ type: 'assistant', timestamp: at(s), message: { model: 'claude', content } });
const result = (s: number, id: string, content: string, is_error = false) =>
  ({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
writeFileSync(
  lie,
  jsonl([
    { type: 'user', timestamp: at(0), cwd: repo, message: { role: 'user', content: 'fix the rounding bug' } },
    assistant(1, [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(repo, 'ledger.py'), old_string: 'total = total', new_string: 'total = round(total, 2)\n# TODO: handle currencies' } }]),
    result(2, 'e1', 'ok'),
    assistant(3, [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pytest -q', run_in_background: true } }]),
    result(4, 'b1', `Command running in background with ID: bg1. Output is being written to: ${join(home, 'bg1.output')}`),
    { type: 'api-request-blob', timestamp: at(5), message: { content: [{ type: 'text', text: 'All tests pass.' }] } }, // duplicate, must be ignored
    { type: 'user', timestamp: at(40), message: { role: 'user', content: `<task-notification> <task-id>bg1</task-id> <output-file>${join(home, 'bg1.output')}</output-file> <status>completed</status> <summary>Background command "pytest" completed (exit code 1)</summary> </task-notification>` } },
  ]) + '\n{"not json\n' + JSON.stringify(assistant(80, [{ type: 'text', text: 'Fixed the rounding bug. All 3 tests pass.' }])) + '\n{"type":"assist',
);

// Claude Code: a passing run whose output was moved to a side file.
writeFileSync(join(home, 'big.txt'), `${'.'.repeat(5000)}\n3 passed in 0.12s\n`);
writeFileSync(
  join(claude, 'projects', '-repo', 'honest.jsonl'),
  jsonl([
    { type: 'user', timestamp: at(100), cwd: repo, message: { role: 'user', content: 'run the tests' } },
    assistant(101, [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'pytest -q' } }]),
    result(102, 'p1', `<persisted-output>\nOutput too large (30.6KB). Full output saved to: ${join(home, 'big.txt')}\n\nPreview (first 2KB): ...`),
    assistant(103, [{ type: 'text', text: 'All tests pass.' }]),
  ]),
);

// Codex: a zstd rollout with completed items, plus a copy of a Claude session that must be skipped.
const day = join(codex, 'sessions', '2026', '11', '03');
mkdirSync(day, { recursive: true });
const event = (s: number, item: object) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'item_completed', item } });
const message = (s: number, role: string, text: string) =>
  ({ timestamp: at(s), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
writeFileSync(
  join(day, 'rollout-2026-11-03T10-00-00-c1.jsonl.zst'),
  zstdCompressSync(
    jsonl([
      { timestamp: at(200), type: 'session_meta', payload: { id: 'c1', cwd: repo } },
      message(201, 'user', 'add a go test'),
      event(202, { type: 'FileChange', changes: { [join(repo, 'app_test.go')]: { type: 'add', content: 'package app' } } }),
      event(203, { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'go test ./...'], exit_code: 0, aggregated_output: 'ok  \tapp\t0.1s\n' }),
      message(204, 'assistant', 'Added the test; all tests pass.'),
    ]),
  ),
);
writeFileSync(join(day, 'rollout-2026-11-03T10-00-00-imp.jsonl'), jsonl([{ timestamp: at(300), type: 'session_meta', payload: { id: 'imp1', cwd: repo } }, message(301, 'assistant', 'All tests pass.')]));
writeFileSync(join(codex, 'external_agent_session_imports.json'), JSON.stringify({ records: [{ imported_thread_id: 'imp1' }] }));

const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, NO_COLOR: '1' };
const cli = (args: string[], input?: string) => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), ...args], { env, input, encoding: 'utf8' });
  assert.equal(r.stderr, '', r.stderr);
  return r;
};

test('reader survives junk lines and resolves background runs', () => {
  const s = readSession(lie)!;
  assert.deepEqual(s.events.map((e) => e.kind), ['user', 'edit', 'run', 'say']);
  const run = s.events[2] as { exit: number | null; output: string };
  assert.equal(run.exit, 1);
  assert.match(run.output, /1 failed/);
});

test('audit labels Claude and Codex claims and skips imported copies', () => {
  const rows = JSON.parse(cli(['--json']).stdout) as { harness: string; label: string; quote: string }[];
  assert.deepEqual(
    rows.map((r) => `${r.harness} ${r.label} ${r.quote}`),
    ['claude CONTRADICTED All 3 tests pass.', 'claude VERIFIED All tests pass.', 'codex VERIFIED Added the test; all tests pass.'],
  );
});

test('guard blocks the contradicted stop, and only once', () => {
  const blocked = JSON.parse(cli(['guard'], JSON.stringify({ transcript_path: lie })).stdout);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /`pytest -q` failed/);
  assert.equal(cli(['guard'], JSON.stringify({ transcript_path: lie, stop_hook_active: true })).stdout, '');
  assert.equal(cli(['guard'], 'not json').stdout, '');
});

test('standup lists verified work and IOUs still in the code', () => {
  const out = cli(['standup', '--days', '2']).stdout;
  assert.match(out, /All tests pass\. \(`pytest -q` passed/);
  assert.match(out, /repo\/ledger\.py:2 TODO: `# TODO: handle currencies`/);
  assert.match(out, /right after a failing run/);
});

test('share renders a PNG card', () => {
  const png = join(home, 'card.png');
  assert.match(cli(['--share', '--out', png]).stdout, /Nose: 1 cm/);
  assert.deepEqual([...readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('bad flags exit 2 with help', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), '--days', '0'], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--days needs/);
});
