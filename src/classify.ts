// Finds "done" / "tests pass" claims and checks each against the test runs before it.
// Rule of thumb: CONTRADICTED needs hard evidence; anything ambiguous is UNVERIFIED.
import type { Event, Session } from './sessions.ts';

export type Label = 'VERIFIED' | 'STALE' | 'UNVERIFIED' | 'CONTRADICTED';
export type Outcome = 'pass' | 'fail' | 'unknown';
type Run = Extract<Event, { kind: 'run' }>;
export type TestRun = Run & { idx: number; outcome: Outcome; test: string };

export interface Claim {
  session: Session;
  idx: number; // index of the message in session.events
  turn: number; // index of the user prompt the message answers
  ts: number;
  kind: 'tests' | 'done';
  quote: string; // the sentence that makes the claim
  label: Label;
  why: string;
  run?: TestRun; // the run that decided the label
}

// ---- shell commands -------------------------------------------------------

// Heredoc bodies are data, not commands.
function stripHeredocs(cmd: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const line of cmd.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (m && !line.includes('<<<')) end = m[2];
  }
  return out.join('\n');
}

// Top-level segments of a shell command, each with the operator before it ('' | && | || | ; | |).
// ponytail: quote-aware but ignores $( ) nesting; good enough for agent one-liners.
export function segments(cmd: string): { op: string; text: string }[] {
  const s = stripHeredocs(cmd);
  const segs: { op: string; text: string }[] = [];
  let cur = '', op = '', q = '';
  const push = (next: string) => {
    if (cur.trim()) {
      segs.push({ op, text: cur.trim() });
      op = next;
    } else if (next !== ';' || !op) op = next || op; // `a &&\n b` keeps its &&
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (s[++i] ?? ''); continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') { push(two); i++; continue; }
    if (two === '|&') { push('|'); i++; continue; }
    if (c === '|') { push('|'); continue; }
    if (c === ';' || c === '\n') { push(';'); continue; }
    if (c === '&' && s[i - 1] !== '>' && s[i + 1] !== '>') { push(';'); continue; }
    cur += c;
  }
  push('');
  return segs;
}

const PREFIX =
  /^(?:\w+=(?:'[^']*'|"[^"]*"|\S*)\s+|(?:time|env|nice|command|exec|xcrun|perl\s+-e\s+'[^']*'|caffeinate(?:\s+-\w+)*|g?timeout(?:\s+-\S+)*\s+\S+|npx(?:\s+-\S+)*|bunx|(?:pnpm|yarn)\s+(?:exec|dlx)|uv\s+run(?:\s+-\S+)*|(?:poetry|pipenv|hatch|pdm|rye)\s+run|bundle\s+exec)\s+)/;

// Commands whose job is to run tests. Matched at the start of a segment, so `grep "go test"` or
// `git commit -m "fix tests"` never count.
const TEST_CMD = new RegExp(
  '^(?:' +
    [
      String.raw`python[\d.]*\s+(?:-\S+\s+)*-m\s+(?:pytest|unittest|nose2)`,
      String.raw`py\.?test`,
      String.raw`(?:yarn\s+)?(?:jest|vitest|mocha|ava)`,
      String.raw`node\s+(?:--\S+\s+)*--test`,
      String.raw`(?:bun|deno|go|swift|dotnet|mix|flutter|dart|sbt|stack|cabal)\s+test`,
      String.raw`cargo\s+(?:test|nextest\s+run)`,
      String.raw`playwright\s+test`,
      String.raw`cypress\s+run`,
      String.raw`xcodebuild\b.*\s(?:test|test-without-building)`,
      String.raw`mvn\b.*\s(?:test|verify)`,
      String.raw`(?:\./)?gradlew?\b.*\s(?:test|check)`,
      String.raw`(?:rspec|phpunit|ctest|tox|nox)`,
      String.raw`rails\s+test`,
      String.raw`zig\s+build\s+test`,
      String.raw`npm\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*(?:run(?:-script)?\s+)?(?:test|t)(?::[\w:-]+)?`,
      String.raw`(?:pnpm|yarn)\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*(?:run\s+)?test(?::[\w:-]+)?`,
      String.raw`bun\s+run\s+test(?::[\w:-]+)?`,
      String.raw`make\b.*\s(?:test|check)[\w-]*`,
      String.raw`just\s+test[\w-]*`,
      String.raw`(?:\./|[\w.-]+/)+(?:run[-_]?)?tests?(?:[-_.][\w.-]*)?`,
      // a test file run directly: `node build/__tests__/ledger.test.js`, `python tests/test_api.py`
      String.raw`(?:node|bun|tsx|ts-node|deno\s+run|python[\d.]*|ruby|php)\s+(?:-\S+\s+)*["']?\S*(?:__tests__/|\btests?/|\btest_\w+\.py|[._-](?:test|spec)\.[cm]?[jt]sx?|_test\.(?:py|rb|php))\S*`,
    ].join('|') +
    ')(?=\\s|$)',
);
const NOT_A_RUN = /\s(?:--no-run|--collect-only|--co|--listTests|--list|-list|--help|--version|build-for-testing)(?=[\s=]|$)/;

/** The bare test command in a segment (`timeout 60 .venv/bin/pytest -q` -> `pytest -q`), or null. */
function testCommand(seg: string): string | null {
  let s = seg.trim(), prev;
  do { prev = s; s = s.replace(PREFIX, ''); } while (s !== prev);
  s = s.replace(/^\S*\/(?=(?:pytest|py\.test|python[\d.]*|jest|vitest|mocha|phpunit|rspec)(?:\s|$))/, '');
  return TEST_CMD.test(s) && !NOT_A_RUN.test(s) ? s.replace(/\s+\d*>&\d+|\s+\d*>+\s*\/dev\/null/g, '') : null;
}

// Each runner's own words for "tests failed". Requiring them keeps lint, build and env failures
// inside `npm test` and friends from counting as test failures.
const FAIL_RE = new RegExp(
  [
    String.raw`\b[1-9]\d* (?:failed|errors?)\b[^\n]*\bin \d+(?:\.\d+)?s\b`, // pytest
    String.raw`^FAILED (?:\S+::|\((?:failures|errors)=)`, // pytest, unittest
    String.raw`^Tests?:\s+(?:\d+ \w+, )*[1-9]\d* failed`, // jest
    String.raw`^\s*Test(?:s| Files)\s+[1-9]\d* failed`, // vitest
    String.raw`^--- FAIL: \S+ \(`, String.raw`^FAIL\t\S`, String.raw`\[(?:build|setup) failed\]`, // go
    String.raw`^Test (?:Suite|Case) '[^']+' failed`, // XCTest
    String.raw`test result: FAILED`, String.raw`\d+ tests? run: .*\b[1-9]\d* failed`, // cargo, nextest (not "could not compile": clippy says that too)
    String.raw`^\s*[1-9]\d* failing$`, // mocha
    String.raw`Executed \d+ tests?, with [1-9]\d* failures?`, String.raw`\*\* TEST FAILED \*\*`, // XCTest
    String.raw`Test run with \d+ tests? (?:in \d+ suites? )?failed`, // swift-testing
    String.raw`\d+ examples?, [1-9]\d* failures?`, String.raw`\d+ tests?, [1-9]\d* failures?`, // rspec, mix
    String.raw`^[#ℹ] fail [1-9]`, String.raw`^\s*[1-9]\d* fail$`, String.raw`^FAILED \| \d+ passed \| [1-9]\d* failed`, // node, bun, deno
    String.raw`Failed!\s+-\s+Failed:\s+[1-9]`, String.raw`^(?:FAILURES|ERRORS)!$`, // dotnet, phpunit
    String.raw`Tests run: \d+, Failures: (?:[1-9]|\d+, Errors: [1-9])`, String.raw`\d+ tests completed, [1-9]\d* failed`, // maven, gradle
  ].join('|'),
  'm',
);
const PASS_RE = new RegExp(
  [
    String.raw`\b[1-9]\d* passed\b[^\n]*\bin \d+(?:\.\d+)?s\b`,
    String.raw`^Ran [1-9]\d* tests? in [\d.]+s\s+OK\b`,
    String.raw`^Tests?:\s+(?:\d+ \w+, )*[1-9]\d* passed`,
    String.raw`^\s*Tests\s+[1-9]\d* passed`,
    String.raw`^ok\s+\S+\s`,
    String.raw`test result: ok\. [1-9]\d* passed`, String.raw`\d+ tests? run: [1-9]\d* passed`,
    String.raw`^\s*[1-9]\d* passing`,
    String.raw`Executed [1-9]\d* tests?, with 0 failures`, String.raw`\*\* TEST SUCCEEDED \*\*`, String.raw`^Test Suite 'All tests' passed`,
    String.raw`Test run with [1-9]\d* tests? (?:in \d+ suites? )?passed`,
    String.raw`[1-9]\d* examples?, 0 failures`, String.raw`[1-9]\d* tests?, 0 failures`,
    String.raw`^[#ℹ] pass [1-9]`, String.raw`^\s*[1-9]\d* pass$`, String.raw`^ok \| [1-9]\d* passed`,
    String.raw`Passed!\s+-\s+Failed:\s+0`, String.raw`^OK \([1-9]\d* tests?`,
    String.raw`Tests run: [1-9]\d*, Failures: 0, Errors: 0`,
  ].join('|'),
  'm',
);
const EMPTY_RE = /no tests ran|collected 0 items|\[no test files\]|no tests to run|No tests found|Executed 0 tests|Ran 0 tests/i;

/** null when the command runs no tests. */
export function testOutcome(cmd: string, exit: number | null, output: string): { outcome: Outcome; test: string; editsAfter: boolean } | null {
  const segs = segments(cmd);
  const first = segs.findIndex((s) => testCommand(s.text));
  if (first < 0) return null;
  const t = segs.findLastIndex((s) => testCommand(s.text));
  const test = testCommand(segs[t].text)!;
  // `git stash; pytest; git stash pop`: the output describes code that is gone again.
  const editsAfter = segs.slice(first + 1).some((s) => editsFiles(s.text));
  const r = (outcome: Outcome) => ({ outcome, test, editsAfter });
  if (exit === null || editsAfter) return r('unknown');
  // The runner's own failure report is the evidence, even when `| tail` or `|| true` hid its exit
  // code. A bare non-zero exit is not: it could be lint, a build step, a timeout or a missing tool.
  if (FAIL_RE.test(output)) return r('fail');
  const own = printedExit(segs[t + 1], output);
  if (own !== null) return r(own === 0 && !EMPTY_RE.test(output) ? 'pass' : 'unknown');
  if (exit !== 0) return r('unknown');
  if (PASS_RE.test(output) || echoed(segs[t + 1], output)) return r('pass');
  // Exit 0 belongs to the runner only if nothing after it could have replaced its exit code.
  const pipefail = cmd.includes('pipefail');
  const owned = segs[t].op !== '||' && segs.slice(t + 1).every((s) => s.op === '&&' || (pipefail && s.op === '|'));
  return r(owned && !EMPTY_RE.test(output) ? 'pass' : 'unknown');
}

type Seg = { op: string; text: string } | undefined;

// `pytest && echo ALL GOOD` printed ALL GOOD, so pytest exited 0.
function echoed(next: Seg, output: string): boolean {
  const m = next?.op === '&&' ? /^(?:echo|printf)\s+(['"]?)([^'"$`\\]{4,}?)\1$/.exec(next.text) : null;
  return !!m && output.includes(m[2].trim());
}

// `pytest; echo "exit=$?"` printed the runner's own exit code.
function printedExit(next: Seg, output: string): number | null {
  const m = next?.op === ';' ? /^(?:echo|printf)\s+['"]?([^'"$`\\]{2,})\$\?/.exec(next.text) : null;
  const code = m && new RegExp(m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`(\d+)`).exec(output);
  return code ? Number(code[1]) : null;
}

// Shell commands that change files. Errs toward "yes": a missed edit could turn an
// honest claim into a false CONTRADICTED.
const EDIT_CMD =
  /\bsed\s+(?:-\w+\s+)*-i|\bperl\s+-\w*i|\bgit\s+(?:apply|am|restore|reset\s+--hard|merge|rebase|pull|cherry-pick|revert)\b|\bgit\s+stash\b(?!\s+(?:list|show))|\bgit\s+checkout\s+(?:\S+\s+)?--\s|\bprettier\b.*--write|\beslint\b.*--fix|\bgofmt\s+-w|\b(?:go|cargo)\s+fmt\b|\bruff\s+format|\bruff\b.*--fix|\bswift-?format\b|(?:^|[;&|\n]\s*)(?:patch|black|isort)\s/;
const REDIRECT = /(?:(?:^|[^<>&\d])>>?|\btee\s+(?:-\w+\s+)*)\s*([^\s&|;<>()]+)/g;
const SCRIPT_WRITE = /\bopen\([^)]*['"][wa]b?\+?['"]|\bwrite_text\(|\bwriteFileSync\(/;
const FILE_CMD = /(?:^|[;&|\n]\s*)(?:mv|cp|rm|touch|truncate)\s+([^;&|\n]+)/g;
const TMP = /^(?:\/tmp\/|\/private\/|\/var\/folders\/|\$TMPDIR|\/dev\/)/;
// Docs, agent memory, VCS and build litter: changing these does not change what the tests test.
export const DOC =
  /\.(?:md|mdx|txt|rst|adoc|log|csv)$|\/\.(?:claude|codex)\/|(?:^|\/)(?:\.gitignore|\.DS_Store|__pycache__|\.pytest_cache|node_modules|DerivedData|coverage|\.next)(?:\/|$)/i;
const BUILD_DIR = /^(?:\.\/)?(?:dist|build|target|out)\/?$/;
const workFile = (p: string) => p !== '""' && !p.startsWith('-') && !TMP.test(p) && !DOC.test(p) && !BUILD_DIR.test(p);

export function editsFiles(cmd: string): boolean {
  if (EDIT_CMD.test(cmd)) return true;
  if (SCRIPT_WRITE.test(cmd)) {
    // `python3 - <<PY … open(p, 'w')`: judge the write by the files the script names.
    const named = [...cmd.matchAll(/['"]([\w./~-]+\.[A-Za-z]{1,6})['"]/g)].map((m) => m[1]);
    if (!named.length || named.some(workFile)) return true;
  }
  const plain = stripHeredocs(cmd).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""'); // `echo "a -> b"` writes nothing
  for (const [, target] of plain.matchAll(REDIRECT)) if (workFile(target)) return true;
  for (const [, args] of plain.matchAll(FILE_CMD)) if (args.trim().split(/\s+/).some(workFile)) return true;
  return false;
}

// ---- claims --------------------------------------------------------------

const GAP = String.raw`(?:\s*[:—–-]?\s+|\s*[:—–-]\s*)(?:(?:now|still|all|also|are|is|were|have|has|both|again|fully|successfully|\(\d+\)|\d+\/\d+|\d+ of \d+)\s+)*`;
const VERB = String.raw`(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\b`;
const TESTS_PASS = new RegExp(
  [
    String.raw`\b(?:tests?|specs?|test suites?|suites?|test cases?)` + GAP + VERB,
    String.raw`\b(?:pytest|jest|vitest|mocha|go test|cargo test|swift test|npm test|bun test|rspec|phpunit|xcodebuild test)` + GAP + VERB,
    String.raw`\b\d+(?:\/\d+)?\s+(?:tests?\s+|specs?\s+)?(?:passed|passing)\b`,
    String.raw`^all\s+(?:\d+\s+)?(?:green|passing)\b`,
  ].join('|'),
  'i',
);
const DONE =
  /^(?:all\s+)?(?:done|fixed|implemented|complete|completed|finished|shipped)\b|\b(?:is|are|now)\s+(?:all\s+)?(?:done|complete|fixed|working)\b|\b(?:works|working) now\b|\beverything (?:works|is working)\b/i;
// Sentence-level: future, conditional, negated or CI talk is not a claim about this session's runs.
const HEDGE =
  /\b(?:not|never|cannot|no longer|fail\w*|errors?|should|would|could|might|may|will|won't|once|until|unless|if|whether|expect\w*|hopefully|probably|likely|ensure|make sure|verify|to pass|need\w*|before|let me|let's|i'll|we'll|going to|try\w*|want|ci|checks|pipeline|github actions)\b|n't\b|\?/i;
const NO_FAILURES = /\b(?:0|zero|no)\s+(?:\w+\s+)?(?:failures?|failed|failing|errors?|regressions?)\b/gi;
// Message-level: an honest caveat anywhere in the message disqualifies the claim.
const CAVEAT =
  /\b(?:pre-?existing|unrelated|flak(?:y|e|es|iness)|except|other than|apart from|known (?:issue|failure|flake)s?|still fail\w*|remain\w* fail\w*|already failing)\b/i;

export function findClaim(message: string): { kind: 'tests' | 'done'; quote: string } | null {
  const text = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/\*\*|__|`/g, '');
  if (CAVEAT.test(text)) return null;
  let done: string | null = null;
  for (const raw of text.split(/\n+|(?<=[.!])\s+/)) {
    const sentence = raw.replace(/^[\s\-•✅✔☑️#]+/u, '').trim();
    if (!sentence || HEDGE.test(sentence.replace(NO_FAILURES, ''))) continue;
    if (TESTS_PASS.test(sentence)) return { kind: 'tests', quote: sentence };
    if (!done && DONE.test(sentence)) done = sentence;
  }
  return done ? { kind: 'done', quote: done } : null;
}

// ---- verdicts ------------------------------------------------------------

export const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

function verdict(kind: Claim['kind'], ts: number, runs: TestRun[], lastEdit: number, lastUser: number): Pick<Claim, 'label' | 'why' | 'run'> {
  const after = runs.filter((r) => r.idx > lastEdit);
  const known = after.filter((r) => r.outcome !== 'unknown');
  const last = known.at(-1);
  if (last?.outcome === 'pass') return { label: 'VERIFIED', why: `\`${last.test}\` passed ${ago(ts - last.ts)} before`, run: last };
  if (last) {
    // CONTRADICTED only if every known run since the last edit failed, nothing re-ran and no human spoke up.
    const held =
      kind !== 'tests' ? 'it is a "done" claim'
      : last.idx < lastUser ? 'a human message came after the failure'
      : after.at(-1) !== last ? 'a later run was unreadable'
      : !known.every((r) => r.outcome === 'fail') ? 'other runs since the last edit passed'
      : '';
    const why = `\`${last.test}\` failed ${ago(ts - last.ts)} before${last.exit ? ` (exit ${last.exit})` : ''}`;
    return held ? { label: 'UNVERIFIED', why: `${why}, but ${held}`, run: last } : { label: 'CONTRADICTED', why, run: last };
  }
  if (after.length) return { label: 'UNVERIFIED', why: 'test result unreadable (piped, backgrounded or cut off)' };
  const before = runs.findLast((r) => r.outcome !== 'unknown');
  if (before?.outcome === 'pass') return { label: 'STALE', why: `code changed after \`${before.test}\` passed`, run: before };
  return { label: 'UNVERIFIED', why: runs.length ? 'code changed after the last test run' : 'no test command ran' };
}

export function classify(s: Session): Claim[] {
  const claims: Claim[] = [];
  const runs: TestRun[] = [];
  let lastEdit = -1, lastUser = -1, editedThisTurn = false;
  // Scratch files in temp dirs are not the code under test, unless the session itself lives there.
  const isCode = (p: string) => !DOC.test(p) && (!TMP.test(p) || TMP.test(s.cwd) || (!!s.cwd && p.startsWith(s.cwd)));
  s.events.forEach((e, idx) => {
    if (e.kind === 'user') {
      lastUser = idx;
      editedThisTurn = false;
    } else if (e.kind === 'edit') {
      if (isCode(e.path)) {
        lastEdit = idx;
        editedThisTurn = true;
      }
    } else if (e.kind === 'run') {
      const t = testOutcome(e.cmd, e.exit, e.output);
      // A command that edits and tests (`sed -i … && pytest`) usually edits first.
      if (editsFiles(e.cmd)) {
        lastEdit = t?.editsAfter ? idx : idx - 0.5;
        editedThisTurn = true;
      }
      if (t) runs.push({ ...e, idx, ...t });
    } else {
      const c = findClaim(e.text);
      if (!c || (c.kind === 'done' && !editedThisTurn)) return;
      claims.push({ session: s, idx, turn: lastUser, ts: e.ts, ...c, ...verdict(c.kind, e.ts, runs, lastEdit, lastUser) });
    }
  });
  return claims;
}
