# Darwin Repository Rules

## Project Router

- Read `/Users/benjijmac/WORKSPACE_INDEX.md` first for global operating rules.
- Project routing lives in `/Users/benjijmac/workspace-audits/PROJECT_REGISTRY.json`; the readable map is `/Users/benjijmac/workspace-audits/PROJECT_CONVERSATION_MAP.md`.
- This file only adds local repo/workspace instructions. More specific local instructions still win inside this repo.
- Do not create competing project maps or move/delete folders from this local adapter.

## Safety

- Default to `DARWIN_MODE=paper`.
- Never start, stop, or restart `darwin-live` as part of autoresearch or routine cleanup.
- Never commit secrets, wallet keys, RPC URLs with credentials, or provider tokens.
- Keep runtime churn out of git: logs, DB files, jsonl outputs, and local env files stay untracked.
- Darwin's north star and 24-hour money gate live in `docs/DARWIN_Z_GOAL.md`; read it before live, canary, or promotion work.
- Quarantined strategies live in `docs/STRATEGY_QUARANTINE.md`; read it before live, canary, or promotion work.
- No strategy may receive larger live size unless Promotion Gate v1 in `docs/PROMOTION_GATE_V1.md` emits an explicit `PASS` record.

## Autoresearch Scope

- `meta_agent.py` may only modify:
  - `src/evolution/EvolutionEngine.ts`
  - `src/genome/GenomeFactory.ts`
  - `src/market/MarketFeed.ts`
  - `src/Orchestrator.ts`
  - `src/execution/BankrollManager.ts`
- `meta_agent.py` must never modify:
  - `src/evolution/MissionAssessment.ts`
  - `src/evaluation/*`
  - docs, logging schema, or automation logic
- Autoresearch must target `darwin-paper-research` only.
- Autoresearch commits must stage only the tuned source file, never `git add -A`.
- If the deployment repo differs from the GitHub push worktree, mirror keeper commits into the clean push worktree before considering the improvement durable.

## Operator Workflow

- Build after TypeScript changes with `npm run build`.
- Use `npm run eval-window -- <since_ms>` or `python3 eval.py <since_ms>` for stable-lane grading by default once split data exists.
- Use `npm run eval-window:stable -- <since_ms>` or `npm run eval-window:research -- <since_ms>` when you need to force a specific paper lane.
- Use `pm2 start ecosystem.config.cjs --only darwin-paper-stable` for stable paper mode.
- Use `pm2 start ecosystem.config.cjs --only darwin-paper-research` for research paper mode.
- Use `pm2 start ecosystem.config.cjs --only darwin-autoresearch` only after `darwin-paper-research` is healthy.
- Start `darwin-live` manually and only after paper mode has been validated.
- `darwin-paper-stable` is the clean measurement lane.
- `darwin-paper-research` is the mutation lane and is research-tuned by default (`DARWIN_RESEARCH_MODE=true`, `20m` / `25` trades).
- Paper sizing should scale with bankroll; do not reintroduce a hard-coded fixed `0.10 SOL` ceiling in paper mode.

## Live Canary Completion Rule

- Do not mark live-migration work as finished until Darwin itself produces the target end-to-end outcome.
- “Finished” for the live canary means all of the following are true:
  - Darwin is running on the deployed VM in `DARWIN_MODE=live`
  - Darwin is using the intended Settlement route for the canary environment
  - one strategy-triggered `migration` buy reaches the live execution path
  - in shadow mode, the logs contain a clean `settlement trace` followed by `settlement shadow result ... err:none`
  - in funded mode, one real `0.0001 SOL` buy confirms on-chain and Darwin auto-stops cleanly after that entry
- Do not call the task done just because:
  - Settlement health checks pass
  - a devnet smoke test passes
  - direct-RPC fallback works
  - the feed sees raw migrations
- Use the simplest path that proves the whole organism:
  - keep live migration-only
  - allow only one new live entry
  - auto-stop after the first confirmed canary entry
  - prefer fixing the earliest upstream constraint instead of tuning downstream symptoms

## Docs

- `GENESIS.md` is the strategy vision, not the source of operational truth.
- `README.md` is the public setup guide.
- `CLAUDE.md` is the operator runbook for the deployed VM.
