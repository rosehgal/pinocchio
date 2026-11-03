#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, relative, resolve, sep } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import type { CardData } from './card.ts';
import { ago, classify, DOC, type Claim, type Label } from './classify.ts';
import { logRoots, readSession, sessionFiles, type Session } from './sessions.ts';

const HELP = `Pinocchio checks your coding agent's "done, all tests pass" against what it actually ran.

Usage
  npx pinocchio-cli [--days 30] [--share] [--json]   audit Claude Code and Codex session logs
  pinocchio standup [--days 1]                     verified work plus IOUs, ready for Slack
  pinocchio guard                                  Claude Code Stop hook (hook JSON on stdin)

Options
  --days N         how far back to look (default 30; standup 1)
  --project DIR    only sessions started in DIR or below it
  --share          also render the worst claim as a PNG card
  --out FILE       card path (default ./pinocchio-card.png)
  --json           print every claim as JSON
  -v, --version    print the version
  -h, --help       print this help

Logs: $CLAUDE_CONFIG_DIR/projects (default ~/.claude) and $CODEX_HOME/sessions (default ~/.codex).
Docs: https://github.com/rosehgal/pinocchio`;

const DAY = 86_400_000;
const project = (s: Session) => basename(s.cwd) || '?';
const harness = (s: Session) => (s.harness === 'claude' ? 'Claude Code' : 'Codex');
const when = (ts: number) =>
  new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const count = (cs: Claim[], l: Label) => cs.filter((c) => c.label === l).length;
// The nose grows 1 cm per claim made right after a failing test run, and only for those.
const nose = (tests: Claim[]) => count(tests, 'CONTRADICTED');

function load(days: number, dir?: string) {
  const since = Date.now() - days * DAY;
  const root = dir && resolve(dir);
  const sessions = sessionFiles(since)
    .map(readSession)
    .filter((s): s is Session => !!s && s.events.some((e) => e.ts >= since))
    .filter((s) => !root || s.cwd === root || s.cwd.startsWith(root + sep));
  const seen = new Set<string>(); // resumed and forked sessions repeat earlier messages
  const claims = sessions
    .flatMap(classify)
    .filter((c) => c.ts >= since && !seen.has(c.ts + c.quote) && !!seen.add(c.ts + c.quote))
    .sort((a, b) => a.ts - b.ts);
  return { since, sessions, claims };
}

// The claim worth a screenshot. Only CONTRADICTED qualifies: "no test run found" can be a run
// Pinocchio did not recognize, and a card must not accuse on a maybe. Boldest wording wins.
function worst(tests: Claim[]): Claim | undefined {
  const bold = (c: Claim) => (/\ball\b/i.test(c.quote) ? 2 : 0) + (/\d/.test(c.quote) ? 1 : 0);
  return tests.filter((c) => c.label === 'CONTRADICTED').sort((a, b) => bold(b) - bold(a) || b.ts - a.ts)[0];
}

const saidAfter = (c: Claim) => `said ${ago(c.ts - c.run!.ts)} after \`${clip(c.run!.test, 36)}\` failed`;

function card(tests: Claim[], days: number, sessions: number): CardData {
  const w = worst(tests);
  const tally = `${count(tests, 'VERIFIED')} verified · ${count(tests, 'STALE')} stale · ${count(tests, 'UNVERIFIED')} unverified · ${count(tests, 'CONTRADICTED')} contradicted`;
  if (!w)
    return {
      headline: `${tests.length} “tests pass” claims. None came right after a failing test run.`,
      verdict: tally,
      meta: `${sessions} Claude Code and Codex sessions · ${span(days)}`,
      stats: 'Pinocchio checks every claim against the test commands the agent actually ran.',
      nose: 0,
      tone: 'green',
    };
  return {
    headline: `“${w.quote}”`,
    verdict: saidAfter(w),
    meta: `${when(w.ts)} · ${harness(w.session)} · ${project(w.session)}`,
    stats: `“Tests pass” claims, ${span(days)}: ${tally}`,
    nose: nose(tests),
    tone: 'red',
  };
}

const span = (days: number) => (days === 1 ? 'last 24 hours' : `last ${days} days`);
const NO_LOGS = (dir?: string) =>
  `No Claude Code or Codex sessions found${dir ? ` for ${resolve(dir)}` : ''} in the time window. Looked in:\n${logRoots().map((r) => `  ${r}`).join('\n')}`;

async function audit(days: number, opt: { json?: boolean; share?: boolean; out?: string; project?: string }) {
  const { sessions, claims } = load(days, opt.project);
  if (!sessions.length && !opt.json) return console.log(NO_LOGS(opt.project));
  if (opt.json) {
    const rows = claims.map((c) => ({
      time: new Date(c.ts).toISOString(),
      harness: c.session.harness,
      project: project(c.session),
      log: c.session.file,
      kind: c.kind,
      label: c.label,
      quote: c.quote,
      why: c.why,
      command: c.run?.cmd,
    }));
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const tests = claims.filter((c) => c.kind === 'tests');
  const done = claims.filter((c) => c.kind === 'done');
  const claude = sessions.filter((s) => s.harness === 'claude').length;
  const never = tests.filter((c) => c.why === 'no test command ran').length;
  const out = [
    '',
    `${styleText('bold', 'Pinocchio')} · ${sessions.length} sessions (Claude Code ${claude}, Codex ${sessions.length - claude}) · ${span(days)}`,
    '',
    `"Tests pass" claims: ${tests.length}`,
  ];
  const rows: [Label, 'green' | 'yellow' | 'gray' | 'red', string][] = [
    ['VERIFIED', 'green', 'tests ran after the last edit and passed'],
    ['STALE', 'yellow', 'tests passed, then the code changed'],
    ['UNVERIFIED', 'gray', `no passing run backs it (${never} with no test run at all)`],
    ['CONTRADICTED', 'red', 'said right after a failing test run'],
  ];
  for (const [label, color, meaning] of rows)
    out.push(`  ${styleText(color, label.padEnd(13))}${String(count(tests, label)).padStart(5)}  ${styleText('dim', meaning)}`);
  if (done.length) {
    out.push('', `"Done" claims after code edits: ${done.length}`);
    out.push(`  ${(['VERIFIED', 'STALE', 'UNVERIFIED'] as Label[]).map((l) => `${l} ${count(done, l)}`).join(' · ')}`);
  }
  const w = worst(tests);
  const lies = tests.filter((c) => c.label === 'CONTRADICTED').slice(-5).reverse();
  if (w) {
    out.push('', `Worst: “${clip(w.quote, 100)}”`, `  ${saidAfter(w)} · ${harness(w.session)} · ${project(w.session)} · ${when(w.ts)}`);
    out.push('', 'Latest contradicted:');
    for (const c of lies) out.push(`  ${when(c.ts)}  ${project(c.session)}  “${clip(c.quote, 60)}”  ${styleText('dim', c.why)}`);
  } else {
    out.push('', 'No claim came right after a failing test run.');
    const check = tests.filter((c) => c.why === 'no test command ran').slice(-3).reverse();
    if (check.length) out.push('Unverified, worth a look (no test run found before them):');
    for (const c of check) out.push(`  ${when(c.ts)}  ${project(c.session)}  “${clip(c.quote, 70)}”`);
  }
  out.push('', `Nose: ${nose(tests)} cm ${styleText('dim', '(1 cm per claim made right after a failing test run)')}`);
  if (opt.share) {
    const { renderCard } = await import('./card.ts');
    const file = resolve(opt.out ?? 'pinocchio-card.png');
    writeFileSync(file, await renderCard(card(tests, days, sessions.length)));
    out.push(`Card: ${file}`);
  } else out.push(styleText('dim', 'Card: --share · Every claim: --json'));
  console.log(out.join('\n'));
}

// ---- guard: Claude Code Stop hook ----------------------------------------

function guard() {
  let input: any;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  // A second block in a row could loop forever; Claude Code sets this flag on the retry.
  if (input?.stop_hook_active || typeof input?.transcript_path !== 'string') return;
  const s = readSession(input.transcript_path);
  if (!s) return;
  const tail = s.events.findLastIndex((e) => e.kind !== 'say');
  const final = input.last_assistant_message;
  if (typeof final === 'string' && final && !s.events.slice(tail + 1).some((e) => e.kind === 'say'))
    s.events.push({ kind: 'say', ts: Math.max(Date.now(), s.events.at(-1)?.ts ?? 0), text: final }); // transcript not flushed yet
  const lie = classify(s).find((c) => c.idx > tail && c.label === 'CONTRADICTED');
  if (!lie?.run) return;
  const r = lie.run;
  const reason = [
    `Pinocchio: you wrote "${lie.quote}", but \`${r.test}\` failed ${ago(lie.ts - r.ts)} earlier, after your last code change, and no test run has passed since.`,
    '',
    'End of that output:',
    r.output.trim().split('\n').slice(-15).join('\n'),
    '',
    'Fix the failures and run the tests again, or tell the user plainly which tests fail.',
  ].join('\n');
  console.log(JSON.stringify({ decision: 'block', reason }));
}

// ---- standup -------------------------------------------------------------

const IOUS: [string, RegExp, boolean][] = [
  // [kind, pattern, must sit in a comment]
  ['TODO', /\b(?:TODO|FIXME|XXX|HACK)\b/, true],
  ['stub', /\braise\s+NotImplementedError|\bthrow new \w*Error\(\s*['"`][^'"`]*not implemented|\b(?:unimplemented|todo)!\(|\b(?:panic|fatalError)\(\s*"[^"]*(?:not implemented|TODO)/i, false],
  ['stub', /\bstub\b/i, true],
  ['for now', /\bfor now\b|\btemporar(?:y|ily)\b|\bworkaround\b|\bquick (?:fix|hack)\b/i, true],
];
const COMMENT = /(?:^|\s)(?:\/\/|#|\/\*|\*|--|<!--)/;

function iouKind(line: string): string | undefined {
  const c = COMMENT.exec(line);
  const comment = c ? line.slice(c.index) : '';
  return IOUS.find(([, re, inComment]) => re.test(inComment ? comment : line))?.[0];
}

function standup(days: number, dir?: string): string {
  const { since, sessions, claims } = load(days, dir);
  if (!sessions.length) return NO_LOGS(dir);
  const last = new Map<string, Claim>(); // one line per answered prompt
  for (const c of claims) if (c.label === 'VERIFIED') last.set(`${c.session.file}#${c.turn}`, c);
  const shipped = [...last.values()].map((c) => {
    const msg = (c.session.events[c.idx] as { text: string }).text.replace(/```[\s\S]*?```/g, '').replace(/[*_`#>]+/g, '');
    const line = msg.split('\n').map((l) => l.trim()).find(Boolean) ?? c.quote;
    const time = new Date(c.run!.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `• ${project(c.session)}: ${clip(line, 120)} (\`${clip(c.run!.test, 40)}\` passed ${time})`;
  });

  const files = new Map<string, string[] | null>();
  const lines = (p: string) => {
    if (!files.has(p)) {
      try {
        files.set(p, readFileSync(p, 'utf8').split('\n'));
      } catch {
        files.set(p, null);
      }
    }
    return files.get(p);
  };
  const ious = new Map<string, string>();
  for (const s of sessions)
    for (const e of s.events) {
      if (e.kind !== 'edit' || e.ts < since || DOC.test(e.path)) continue;
      for (const added of e.added) {
        const kind = iouKind(added);
        const body = kind ? lines(e.path) : null;
        const at = body?.findIndex((l) => l.trim() === added.trim()) ?? -1;
        if (!kind || at < 0) continue; // only IOUs still in the code
        const where = e.path.startsWith(`${s.cwd}/`) ? `${project(s)}/${relative(s.cwd, e.path)}` : e.path.replace(homedir(), '~');
        ious.set(`${e.path}:${at}`, `• ${where}:${at + 1} ${kind}: \`${clip(added.trim(), 90)}\``);
      }
    }

  const unbacked = claims.filter((c) => c.label !== 'VERIFIED');
  const contradicted = count(unbacked, 'CONTRADICTED');
  const cap = (xs: string[]) => (xs.length > 15 ? [...xs.slice(0, 15), `• …and ${xs.length - 15} more`] : xs);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return [
    `*Standup* · ${today} · ${span(days)}`,
    '',
    '*Done, with a passing test run behind it*',
    ...(shipped.length ? cap(shipped) : ['• nothing verified']),
    '',
    `*Claims with no passing test run after the last edit:* ${unbacked.length}${contradicted ? ` (${contradicted} right after a failing run)` : ''}`,
    '',
    '*IOUs left in the code*',
    ...(ious.size ? cap([...ious.values()]) : ['• none']),
    '',
    '_Checked by Pinocchio · npx pinocchio-cli_',
  ].join('\n');
}

// ---- main ----------------------------------------------------------------

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0); // `pinocchio | head`
  throw e;
});

const options = {
  days: { type: 'string' },
  project: { type: 'string' },
  json: { type: 'boolean' },
  share: { type: 'boolean' },
  out: { type: 'string' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

async function main(argv: string[]) {
  const command = argv[0] === 'guard' || argv[0] === 'standup' ? argv[0] : undefined;
  if (command === 'guard') {
    try {
      guard();
    } catch {} // a broken hook must never trap the agent
    return;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: command ? argv.slice(1) : argv, options, allowPositionals: false });
  } catch (e) {
    console.error(`pinocchio: ${(e as Error).message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const opt = parsed.values;
  if (opt.help) return console.log(HELP);
  if (opt.version) return console.log(createRequire(import.meta.url)('../package.json').version);
  const n = opt.days === undefined ? (command === 'standup' ? 1 : 30) : Number(opt.days);
  if (!(n > 0 && n <= 3650)) {
    console.error(`pinocchio: --days needs a number of days between 1 and 3650, got "${opt.days}"`);
    process.exitCode = 2;
    return;
  }
  if (command === 'standup') console.log(standup(n, opt.project));
  else await audit(n, opt);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(`pinocchio: ${(e as Error).message}`);
  if (process.env.DEBUG) console.error(e);
  process.exitCode = 1;
}
