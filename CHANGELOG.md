# Changelog

## 0.1.0 (2026-11-03)

- Audit Claude Code and Codex session logs: every "tests pass" claim labeled VERIFIED, STALE, UNVERIFIED or CONTRADICTED.
- `--share` card rendered locally with satori and resvg. Quotes only contradicted claims.
- `pinocchio guard`: Claude Code Stop hook that blocks a "tests pass" made right after a failing run.
- `pinocchio standup`: verified work plus IOUs (new TODOs, stubs, "for now" hacks), Slack-ready.
- Reads background task results, persisted outputs and zstd Codex rollouts; skips Codex copies of Claude sessions.
