# Darwin Autoresearch — Agent Program

## Ultimate Goal
Turn a small SOL balance into a system that can eventually earn 100+ SOL/day by catching real migration upside, not by gaming paper metrics.

Every experiment should improve Darwin's odds of surviving and scaling in live conditions with real fees, slippage, liquidity, and latency.

## What Darwin is optimizing now
Darwin no longer uses a single win-rate-first score as its source of truth.

Runtime selection, `npm run eval-window`, and autoresearch all use one shared mission assessment with:

- hard-fail gates
- quality tiers: `tier_a`, `tier_b`, `tier_c`, `hard_fail`
- an ordered rank tuple inside each tier

The dashboard metrics are:

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

The real question for every change:
does this increase Darwin's ability to capture outsized migration winners, keep dead-pump noise low, and stay scalable as position size grows?

## What you are optimizing
You are a code agent. Each experiment:

1. makes ONE targeted change to ONE approved TypeScript runtime file
2. rebuilds Darwin
3. restarts only the paper app
4. waits for an 8-minute paper window
5. checks the shared mission assessment

Keeper candidates must now:

- reach at least 30 paper trades per window
- clear hard-fail gates in every validation window
- improve the aggregate mission rank tuple over baseline
- avoid regressing `migration_win_rate`
- avoid worsening `no_pump_bail_pct` or `max_drawdown_pct` by more than 5% relative

## What matters most
Prioritize changes that:

1. increase bankroll growth and outsized winners on migration trades
2. increase migration share without breaking liquidity discipline
3. reduce `no_pump_bail` noise from non-alpha signals
4. preserve or improve live-scalable fill behavior

Do NOT optimize for smoother paper stats if they reduce migration upside.

## Current runtime assumptions

- Darwin is paper-first.
- Live mode stays off unless explicitly promoted later.
- Dynamic liquidity guards are active.
- Paper execution includes fees, slippage, failed txs, and entry-delay impact.
- Signal cooldowns are separated by signal type, so migration is not suppressed by noisy `amm_activity` or `whale_buy`.

## The tunable files

### 1. `src/evolution/EvolutionEngine.ts`
Controls preservation, culling, breeding, and refill behavior.

Good targets:
- preserving the right tiers
- culling weak genomes more decisively
- refill mix between offspring, mutation, and fresh exploration

### 2. `src/genome/GenomeFactory.ts`
Controls what new genomes look like.

Good targets:
- migration-rooted majority
- exploration slice size
- exit defaults for migration-biased vs exploration-biased genomes
- mutation resistance and risk ranges

### 3. `src/market/MarketFeed.ts`
Controls what signals enter Darwin.

Good targets:
- migration signal priority
- better suppression of noisy `amm_activity`
- smarter cooldown behavior
- cleaner low-liquidity rejection

### 4. `src/Orchestrator.ts`
Controls routing, sizing gates, and skip decisions.

Good targets:
- better liquidity/fill decision policy
- better entry filtering
- clearer mission-aligned skip behavior

### 5. `src/execution/BankrollManager.ts`
Controls position sizing and pool-depth pressure.

Good targets:
- dynamic sizing logic
- signal multipliers
- bankroll protection that still allows upside capture

## Do not modify

- `src/evolution/MissionAssessment.ts`
- `src/evaluation/*`
- `meta_agent.py`
- docs or logging schema

These are the source-of-truth grading and operator layers. Darwin must not grade its own homework.

## Rules

1. ONE file per experiment.
2. The file must compile cleanly with `tsc`.
3. Do not add new imports.
4. Do not change dependent function signatures.
5. Prefer changes that make Darwin more migration-native, not more generic.
6. State the hypothesis clearly before returning code.
7. Return ONLY the complete modified file. No markdown fences.
