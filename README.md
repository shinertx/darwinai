# Darwin AI

Darwin is an evolutionary Solana trading organism that listens to PumpSwap market events, evaluates a population of genomes, and executes either simulated or live trades depending on runtime mode.

The project is now graded on a mission dashboard instead of a single win-rate-heavy score. Darwin prefers strategies that grow bankroll, catch outsized migration winners, keep `no_pump_bail` noise down, and stay scalable against pool depth.

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

## Mission Assessment

Darwin runtime selection, `npm run eval-window`, and autoresearch all share the same assessment logic. The primary dashboard is:

- `bankroll_growth_pct`
- `avg_winner_pct`
- `best_trade_pct`
- `migration_share`
- `migration_win_rate`
- `profit_factor`
- `no_pump_bail_pct`
- `max_drawdown_pct`
- `trade_count`
- `migration_trades`
- `fill_ratio`

Selection uses hard-fail gates first, then `tier_a` / `tier_b` / `tier_c`, then an ordered rank tuple inside each tier.

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

- `src/evolution/EvolutionEngine.ts`
- `src/genome/GenomeFactory.ts`
- `src/market/MarketFeed.ts`
- `src/Orchestrator.ts`
- `src/execution/BankrollManager.ts`

It uses the OpenAI Responses API with:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` defaulting to `gpt-5.3-codex`
- `OPENAI_REASONING_EFFORT`
- `AUTORESEARCH_TARGET_APP=darwin-paper`

By default, autoresearch now waits for at least `30` paper trades per window and validates keeper candidates across `2` consecutive paper windows before committing them.

Candidates only stick when:

- every validation window clears hard-fail gates
- the aggregate candidate improves the mission rank tuple over baseline
- `migration_win_rate` does not regress
- `no_pump_bail_pct` and `max_drawdown_pct` do not worsen by more than `5%` relative

The autoresearch loop never stops or restarts `darwin-live`.

Use the shared evaluator directly with:

```bash
npm run eval-window -- 0
python3 eval.py 0
```

## Ops Scripts

Tracked helper scripts live in `scripts/ops/` so they work from a clean clone and on the VM without absolute paths. Run them from the repo root, for example:

```bash
node scripts/ops/diagnose.mjs
node scripts/ops/check_wsol.mjs
node scripts/ops/init_wsol_funded.mjs
```

## CI

GitHub Actions runs `npm ci` and `npm run build` on Node 22 for every push and pull request.
