# Darwin AI

Darwin is an evolutionary Solana trading organism that listens to PumpSwap market events, evaluates a population of genomes, and executes either simulated or live trades depending on runtime mode.

## Docs

- [GENESIS.md](./GENESIS.md): strategy vision and long-term mission
- [CLAUDE.md](./CLAUDE.md): operator notes for the deployed system
- [AGENTS.md](./AGENTS.md): repository rules for autonomous agents and automation

## Runtime Modes

- `DARWIN_MODE=paper`: default and safest mode; uses `PaperExecutor`
- `DARWIN_MODE=live`: explicit opt-in; uses `LiveExecutor` and requires live credentials

Legacy `PAPER_TRADING` and `PAPER_TRADE` values are still read for one transition cycle, but Darwin will warn until `DARWIN_MODE` is set explicitly.

## Liquidity Guards

Darwin now uses both hard signal floors and a dynamic pool-depth guard:

- `MIGRATION_MIN_LIQUIDITY_SOL=25`
- `NEW_POOL_MIN_LIQUIDITY_SOL=30`
- `AMM_ACTIVITY_MIN_LIQUIDITY_SOL=50`
- `WHALE_BUY_MIN_LIQUIDITY_SOL=50`
- `DARWIN_TARGET_ENTRY_POOL_PCT=0.03`
- `DARWIN_MIN_MEANINGFUL_FILL_RATIO=0.5`

That means Darwin skips pools that are obviously too thin, and it also skips signals where the pool cannot support a meaningful fraction of the intended position size.

## Quick Start

1. Copy `.env.example` to `.env` and fill in the RPC, websocket, and API credentials.
2. Install dependencies with `npm install`.
3. Build with `npm run build`.
4. Start paper mode with `npm run start:paper` or `pm2 start ecosystem.config.cjs --only darwin-paper`.

## PM2 Profiles

- `darwin-paper`: default trading app for paper mode
- `darwin-live`: live trading app; defined but stopped by default
- `darwin-autoresearch`: OpenAI-driven experiment loop; targets `darwin-paper` only

Recommended boot sequence:

```bash
npm run build
pm2 start ecosystem.config.cjs --only darwin-paper
pm2 start ecosystem.config.cjs --only darwin-autoresearch
```

Live mode stays manual:

```bash
pm2 start ecosystem.config.cjs --only darwin-live
```

## Autoresearch

`meta_agent.py` runs short paper-trading experiments against the approved tunable files:

- `src/evolution/FitnessScorer.ts`
- `src/genome/GenomeFactory.ts`
- `src/market/MarketFeed.ts`

It uses the OpenAI Responses API with:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` defaulting to `gpt-5.3-codex`
- `OPENAI_REASONING_EFFORT`
- `AUTORESEARCH_TARGET_APP=darwin-paper`

By default, autoresearch now waits for at least `30` paper trades per window and validates keeper candidates across `2` consecutive paper windows before committing them.

The autoresearch loop never stops or restarts `darwin-live`.

## Ops Scripts

Tracked helper scripts live in `scripts/ops/` so they work from a clean clone and on the VM without absolute paths. Run them from the repo root, for example:

```bash
node scripts/ops/diagnose.mjs
node scripts/ops/check_wsol.mjs
node scripts/ops/init_wsol_funded.mjs
```

## CI

GitHub Actions runs `npm ci` and `npm run build` on Node 22 for every push and pull request.
