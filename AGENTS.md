# Darwin Repository Rules

## Safety

- Default to `DARWIN_MODE=paper`.
- Never start, stop, or restart `darwin-live` as part of autoresearch or routine cleanup.
- Never commit secrets, wallet keys, RPC URLs with credentials, or provider tokens.
- Keep runtime churn out of git: logs, DB files, jsonl outputs, and local env files stay untracked.

## Autoresearch Scope

- `meta_agent.py` may only modify:
  - `src/evolution/FitnessScorer.ts`
  - `src/genome/GenomeFactory.ts`
  - `src/market/MarketFeed.ts`
- Autoresearch must target `darwin-paper` only.
- Autoresearch commits must stage only the tuned source file, never `git add -A`.

## Operator Workflow

- Build after TypeScript changes with `npm run build`.
- Use `pm2 start ecosystem.config.cjs --only darwin-paper` for paper mode.
- Use `pm2 start ecosystem.config.cjs --only darwin-autoresearch` only after `darwin-paper` is healthy.
- Start `darwin-live` manually and only after paper mode has been validated.

## Docs

- `GENESIS.md` is the strategy vision, not the source of operational truth.
- `README.md` is the public setup guide.
- `CLAUDE.md` is the operator runbook for the deployed VM.
