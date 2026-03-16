# Darwin Repository Rules

## Safety

- Default to `DARWIN_MODE=paper`.
- Never start, stop, or restart `darwin-live` as part of autoresearch or routine cleanup.
- Never commit secrets, wallet keys, RPC URLs with credentials, or provider tokens.
- Keep runtime churn out of git: logs, DB files, jsonl outputs, and local env files stay untracked.

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

## Docs

- `GENESIS.md` is the strategy vision, not the source of operational truth.
- `README.md` is the public setup guide.
- `CLAUDE.md` is the operator runbook for the deployed VM.
