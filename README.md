# Pinocchio

Your coding agent says "done, all tests pass". Pinocchio checks that sentence against the commands the session log shows it actually ran, and grows a nose when it catches a lie.

```bash
npx pinocchio-cli
```

It reads your Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) logs, finds every claim that tests pass, and labels it:

| Label | Meaning |
|---|---|
| VERIFIED | a test command ran after the agent's last code edit, and passed |
| STALE | tests passed, then the code changed and nothing re-ran |
| UNVERIFIED | no passing run backs it: nothing ran, or the result was unreadable |
| CONTRADICTED | said right after a failing test run |

Everything stays on your machine. No account, no API key, no network, no telemetry. Node 22.18 or newer.

```
Pinocchio · 300 sessions (Claude Code 279, Codex 21) · last 30 days

"Tests pass" claims: 239
  VERIFIED       125  tests ran after the last edit and passed
  STALE           75  tests passed, then the code changed
  UNVERIFIED      39  no passing run backs it (15 with no test run at all)
  CONTRADICTED     0  said right after a failing test run

"Done" claims after code edits: 141
  VERIFIED 9 · STALE 75 · UNVERIFIED 57

Nose: 0 cm (1 cm per claim made right after a failing test run)
```

That is the author's last 30 days. The agent was sloppy about re-running tests after its last edit, but it never claimed a pass right after a failure.

## The nose

1 cm per CONTRADICTED claim. Nothing else grows it.

## Share card

```bash
npx pinocchio-cli --share
```

Writes `pinocchio-card.png`, rendered locally with satori and resvg. The card quotes your worst contradicted claim, with its timestamp and the command that failed. With no contradicted claims it shows a clean record instead. It never quotes an UNVERIFIED claim, because "no test run found" can also mean a run Pinocchio did not recognize, and a screenshot should not accuse anyone on a maybe.

## Guard: block the lie before you read it

`pinocchio guard` is a Claude Code Stop hook. When the agent's final message says tests pass right after a failing run, the hook blocks the stop and hands the agent the failing output, so it fixes the tests or tells you they fail.

```bash
npm install -g pinocchio-cli
```

Then add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "pinocchio guard" }] }]
  }
}
```

It only blocks CONTRADICTED claims, and it stands down when Claude Code marks the stop as a retry (`stop_hook_active`), so it cannot trap the agent in a loop. Any error inside the hook lets the stop through.

## Standup

```bash
npx pinocchio-cli standup
```

Slack-ready text for the last 24 hours: work that a passing test run backs, how many claims nothing backs, and the IOUs the agent left in your code (new TODOs, stubs and "for now" hacks that are still there).

```
*Standup* · Tue 3 Nov · last 24h

*Done, with a passing test run behind it*
• ledger: Fixed rounding in two-way splits; all 18 tests pass. (`pytest -q` passed 22:05)

*Claims with no passing test run after the last edit:* 12

*IOUs left in the code*
• ledger/api/notify.py:15 for now: `# for now, email only`
• sync/src/merge.rs:349 stub: `unimplemented!()`

_Checked by Pinocchio · npx pinocchio-cli_
```

## How it decides

Pinocchio would rather miss a lie than invent one.

- **Claims.** A sentence in the agent's own message saying tests pass: "all 42 tests pass", "tests are green", "42 passed". It skips plans ("let me run the tests"), conditionals, negations, questions and CI talk, and any message with a caveat ("except", "pre-existing", "flaky"). "Done" claims count only in turns that edited code, and are never marked CONTRADICTED.
- **Test runs.** pytest, unittest, jest, vitest, mocha, `node --test`, bun, deno, go, cargo and nextest, swift, xcodebuild, dotnet, maven, gradle, rspec, phpunit, mix and more; `npm`/`pnpm`/`yarn`/`make`/`just` test wrappers; test files run directly (`node x.test.js`). Background runs are matched to their completion notice.
- **Failures.** A run fails only when the test runner itself reports failures (pytest's `1 failed … in 0.31s`, go's `--- FAIL`, jest's `Tests: 1 failed`, and so on). A non-zero exit alone is not enough, because `npm test` also fails on lint and `cargo clippy` prints "could not compile". When `| tail` or `|| true` hides the exit code, the runner's own summary still counts.
- **CONTRADICTED** needs all of these: every test run since the agent's last code edit failed, nothing re-ran after the failure, and no human message came in between.
- **Edits.** Edit and Write tools, `apply_patch`, and shell commands that write files (`sed -i`, redirects, scripts that open files for writing, `git stash`/`apply`/`pull`). Docs, `.gitignore` and temp files don't count. When unsure it assumes an edit happened, which can turn VERIFIED into STALE but never creates a CONTRADICTED.

Known misses, all of which land in UNVERIFIED rather than CONTRADICTED:

- tests run over `ssh` or through scripts with unusual names
- a subagent's test runs don't back its parent session's claims
- OpenCode and Gemini CLI logs are not read yet

`pinocchio --json` prints every claim with its label, reason and log file, so you can check any verdict yourself.

## Reusing the log reader

`src/sessions.ts` turns Claude Code and Codex logs into one timeline of events (`user`, `say`, `run`, `edit`) and knows nothing about claims. Other tools can build on it.

## Development

```bash
git clone https://github.com/rosehgal/pinocchio && cd pinocchio
npm install && npm test && node dist/cli.js
```

MIT License
