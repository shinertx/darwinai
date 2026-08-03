# Darwin AI

Darwin is an evolutionary Solana trading organism that listens to PumpSwap market events, evaluates a population of genomes, and executes either simulated or live trades depending on runtime mode.

The project is now graded on a mission dashboard instead of a single win-rate-heavy score. Darwin prefers strategies that grow bankroll, catch outsized migration winners, keep `no_pump_bail` noise down, and stay scalable against pool depth.

## Docs

- [GENESIS.md](./GENESIS.md): strategy vision and long-term mission
- [CLAUDE.md](./CLAUDE.md): operator notes for the deployed system
- [AGENTS.md](./AGENTS.md): repository rules for autonomous agents and automation
- [docs/PROJECT1_EDGE_ITERATION.md](./docs/PROJECT1_EDGE_ITERATION.md): iterative PumpSwap edge-discovery program for Project 1

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
- `DARWIN_PAPER_MAX_POSITION_PCT=0.12`

That means Darwin skips pools that are obviously too thin, and it also skips signals where the pool cannot support a meaningful fraction of the intended position size.
Paper sizing now scales with bankroll instead of freezing against a fixed `0.10 SOL` ceiling. If you want a hard paper ceiling for a test run, set `DARWIN_PAPER_MAX_POSITION_SOL`.

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
4. Start stable paper mode with `npm run start:paper:stable` or `pm2 start ecosystem.config.cjs --only darwin-paper-stable`.
5. Start research paper mode with `npm run start:paper:research` or `pm2 start ecosystem.config.cjs --only darwin-paper-research`.

## PM2 Profiles

- `darwin-paper-stable`: long-running paper organism; not mutated by autoresearch
- `darwin-paper-research`: research sandbox; restarted and mutated by autoresearch
- `darwin-live`: live trading app; defined but stopped by default
- `darwin-live-canary`: one-shot live canary app; stopped by default and configured to not restart after auto-stop
- `darwin-autoresearch`: OpenAI-driven experiment loop; targets `darwin-paper-research` only

Recommended boot sequence:

```bash
npm run build
pm2 start ecosystem.config.cjs --only darwin-paper-stable
pm2 start ecosystem.config.cjs --only darwin-paper-research
pm2 start ecosystem.config.cjs --only darwin-autoresearch
```

Recommended operator model:

- keep `darwin-paper-stable` running continuously for clean paper evaluation
- let `darwin-paper-research` absorb autoresearch restarts and mutations
- promote only proven keepers from research into stable

Live mode stays manual:

```bash
pm2 start ecosystem.config.cjs --only darwin-live
```

For a tiny one-entry live proof, use the one-shot canary profile instead:

```bash
pm2 start ecosystem.config.cjs --only darwin-live-canary
```

Live mode is intentionally stricter than paper:

- by default, live only considers `migration` signals so it does not burn latency on lower-value noise
- only one live attempt is allowed per mint per cooldown window
- live entries must be fresh, and migrations use a short readiness delay, aggressive pool-lookup timeout, and a hard max age tuned for real pool bring-up
- only historically-qualified or currently-qualified `tier_b+` strategies are allowed to send live buys
- Darwin chooses one best live candidate per signal instead of dogpiling every strategy onto the same mint

Settlement routing is optional in live mode. If `SETTLEMENT_API_URL` and `SETTLEMENT_LAND_API_KEY` are unset, Darwin uses the direct RPC send path. If they are set, live execution uses `txready -> local sign -> land/submit -> poll job`.

By default, Settlement is treated as an execution assist, not the strategy itself:

- if Settlement is unavailable before a job is accepted, Darwin can fall back to direct RPC send
- if Settlement accepts the job and it later fails, expires, or times out, Darwin treats that as a failed trade
- set `DARWIN_SETTLEMENT_STRICT=true` only if you explicitly want Settlement to be mandatory

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
- `AUTORESEARCH_TARGET_APP=darwin-paper-research`
- optional `AUTORESEARCH_MIRROR_DIR` to mirror keeper commits into a clean push worktree
- optional `AUTORESEARCH_PUSH_AFTER_KEEP=true` to push mirrored keeper commits automatically

By default, autoresearch now waits for at least `30` paper trades per window and validates keeper candidates across `2` consecutive paper windows before committing them.

GitHub swarm mode is available for private multi-runner coordination. When `AUTORESEARCH_ENABLE_SWARM=true`, runners coordinate through a dedicated branch-backed memory plane instead of operating as isolated solo loops.

Swarm branch roles:

- `main`: stable/manual branch
- `research/current`: auto-promoted keeper branch for the research lane
- `swarm/state`: coordination branch for claims, results, insights, hypotheses, and best-state

Required swarm env:

- `AUTORESEARCH_RUNNER_ID`
- `AUTORESEARCH_COORD_WORKTREE`
- `AUTORESEARCH_COORD_BRANCH=swarm/state`
- `AUTORESEARCH_RESEARCH_BRANCH=research/current`
- `AUTORESEARCH_PUSH_REMOTE=origin`
- `AUTORESEARCH_CLAIM_TTL_MIN=45`
- `AUTORESEARCH_CLAIM_HEARTBEAT_MIN=5`
- `AUTORESEARCH_SYNC_EVERY_EXPERIMENTS=1`

Swarm behavior in v1:

- runners claim experiments before editing
- each experiment publishes a result JSON, an insight Markdown note, and a next-step hypothesis JSON
- keepers auto-promote only into `research/current`
- `swarm/best/research.json` is the source of truth for the best research keeper
- stable and live promotion remain manual
- if GitHub is unavailable, the runner continues locally and backfills pending publications later

When `DARWIN_RESEARCH_MODE=true`, Darwin uses research-friendly generation defaults of `20` minutes or `25` trades unless you override them explicitly. Stable paper defaults remain `60` minutes or `75` trades.

Candidates should be promoted from research to stable only when:

- every validation window clears hard-fail gates
- the aggregate candidate improves the mission rank tuple over baseline
- `migration_win_rate` does not regress
- `no_pump_bail_pct` and `max_drawdown_pct` do not worsen by more than `5%` relative

The autoresearch loop never stops or restarts `darwin-live`.
If your deployment repo is not the same worktree you push from, set `AUTORESEARCH_MIRROR_DIR` so keeper commits do not get stranded only on the VM.

Use the shared evaluator directly with:

```bash
npm run eval-window -- 0
npm run eval-window:stable -- 0
npm run eval-window:research -- 0
python3 eval.py 0
```

When split paper lanes exist, the generic `npm run eval-window -- <since_ms>` and `python3 eval.py <since_ms>` commands default to the stable lane.

## Ops Scripts

Tracked helper scripts live in `scripts/ops/` so they work from a clean clone and on the VM without absolute paths. Run them from the repo root, for example:

```bash
node scripts/ops/diagnose.mjs
node scripts/ops/check_wsol.mjs
node scripts/ops/init_wsol_funded.mjs
npm run analyze:pumpswap:alt-edges
```

For a dedicated devnet proof of the Settlement path, use:

```bash
npm run smoke:settlement:devnet
```

That smoke test sends a tiny devnet transfer through the Settlement API and confirms it on-chain. It is the right first proof for Settlement routing. It is not the same thing as validating the full Darwin live trading organism, which still depends on the mainnet PumpSwap market/feed stack.

## CI

GitHub Actions runs `npm ci` and `npm run build` on Node 22 for every push and pull request.
