# Darwin Operator Notes

## What this repo is

Darwin is an evolutionary Solana trading system with two execution profiles:

- `paper`: default and safest; uses `PaperExecutor`
- `live`: explicit opt-in; uses `LiveExecutor` and real funds

Autoresearch is a separate OpenAI-driven loop that experiments only against the paper app.

## Safety defaults

- Set `DARWIN_MODE=paper` unless you are intentionally validating live trading.
- `darwin-live` is defined in PM2 but should stay stopped unless explicitly started.
- Autoresearch must target `darwin-paper` only and must never restart `darwin-live`.
- No secrets belong in source files, docs, or tracked scripts.

## PM2 apps

- `darwin-paper`: primary paper-trading process
- `darwin-live`: live-trading process, stopped by default
- `darwin-autoresearch`: experiment runner, stopped by default until OpenAI env is ready

Use the ecosystem file:

```bash
pm2 start ecosystem.config.cjs --only darwin-paper
pm2 start ecosystem.config.cjs --only darwin-autoresearch
pm2 start ecosystem.config.cjs --only darwin-live
```

## Required env

Minimum paper mode:

```bash
DARWIN_MODE=paper
RPC_URL=...
RPC_URLS=...
WSS_URL=...
STARTING_BALANCE_SOL=1.0
DARWIN_POP_SIZE=16
DARWIN_GENERATION_INTERVAL_MIN=60
DARWIN_GENERATION_TRADE_THRESHOLD=75
MIGRATION_MIN_LIQUIDITY_SOL=25
AMM_ACTIVITY_MIN_LIQUIDITY_SOL=50
DARWIN_TARGET_ENTRY_POOL_PCT=0.03
DARWIN_MIN_MEANINGFUL_FILL_RATIO=0.5
```

Live-only env:

```bash
PRIVATE_KEY=...
LIVE_TRADE_SIZE_SOL=0.001
LIVE_MIN_BALANCE_SOL=1.0
```

Autoresearch:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.3-codex
OPENAI_REASONING_EFFORT=medium
AUTORESEARCH_TARGET_APP=darwin-paper
AUTORESEARCH_MIN_TRADES=30
AUTORESEARCH_VALIDATION_WINDOWS=2
```

Legacy `PAPER_TRADING` and `PAPER_TRADE` values still map into the new mode logic temporarily, but Darwin warns until `DARWIN_MODE` is set explicitly.

## Common commands

```bash
# Install and build
npm install
npm run build

# Start paper mode
pm2 start ecosystem.config.cjs --only darwin-paper

# Check health
pm2 list
pm2 logs darwin-paper --lines 50 --nostream
pm2 logs darwin-autoresearch --lines 50 --nostream

# Evaluate paper performance
npm run eval-window -- 0
python3 eval.py 0

# Stop live mode if it was started
pm2 stop darwin-live
```

## Autoresearch rules

- Tunable files only:
  - `src/evolution/EvolutionEngine.ts`
  - `src/genome/GenomeFactory.ts`
  - `src/market/MarketFeed.ts`
  - `src/Orchestrator.ts`
  - `src/execution/BankrollManager.ts`
- Commits must stage only the tuned file, never logs or runtime outputs.
- If build or paper-app health fails, revert immediately and leave `darwin-paper` on the last known good build.
- Keepers must improve the shared mission rank tuple, not just a single scalar score.

## Related docs

- `README.md`: public setup and repo overview
- `AGENTS.md`: automation contract for code agents
- `GENESIS.md`: long-term strategy and mission, not the operator runbook
