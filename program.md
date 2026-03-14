# Darwin Autoresearch — Agent Program

## Ultimate Goal
Turn 2 SOL into 100+ SOL/day through live trading on migration signals.

Every experiment you run should push toward this. Paper metrics are a proxy.
The real question for every change: does this increase the probability that
a migration signal trade is profitable LIVE — after real fees, slippage, and
competing bots?

Prioritise changes that:
1. Increase migration signal win rate (most important)
2. Reduce amm_activity noise (second most important)
3. Protect capital on losers (third)

Do NOT optimise for paper score at the expense of real-world viability.

## What is Darwin?
Darwin is an evolutionary trading bot on Solana PumpSwap. It runs 16 strategy "genomes" simultaneously in paper trading mode against real live market signals. A genetic algorithm evolves genomes across generations — fit ones breed, unfit ones die.

## What you are optimizing
You are a code agent. Each experiment you make ONE targeted change to ONE TypeScript source file, rebuild Darwin, let it run for 8 minutes, then measure whether the change improved the eval score.

## The eval score (higher = better)
```
score = profit_factor * 0.40 + win_rate * 0.40 - avg_loss_penalty
```
- profit_factor: gross wins / gross losses (capped at 5.0)
- win_rate: % of trades that are profitable
- Penalties: >85% no_pump_bail exits, win_rate < 8%
- Higher is always better. Target: score > 3.0

## Current state (as of latest run)
- win_rate: ~40-50% (was 6% at start — already massively improved)
- no_pump_bail: ~45-55% (was 91% at start)
- profit_factor: hitting 5.0 cap on good runs
- score: ~2.0-2.3 (target is 3.0+)

## What has already worked (DO NOT undo these)
1. **Stronger spam tax** (FitnessScorer): Increasing per-trade/hour penalty killed noisy genomes
2. **More migration-biased genomes** (GenomeFactory): Raising migration population % from 40% to higher dramatically improved win rate
3. **Spam threshold 2→4 trades/hr** (FitnessScorer): Stopped over-penalizing occasional traders

## What has failed (DO NOT retry these)
- Extending noPumpBailMs (longer bail windows hurt — fast exits are better)
- Lowering noPumpBailMs aggressively (over-pruned, too few trades)
- Raising amm_activity trade size floor past 8 SOL (over-filtered signals)
- Increasing migration bias past current level (already near optimal)
- Raising spam tax too aggressively (score collapsed to 0.02)
- Tweaking FitnessScorer weight redistribution (consistently hurts)

## The core remaining problem
~50% of trades still exit via `no_pump_bail` at -5% loss. These are `amm_activity` signals with no predictive value. The alpha is ONLY in `migration` signals which average +200% on take_profit exits.

## The three tunable files

### 1. src/evolution/FitnessScorer.ts
Controls which genomes SURVIVE. Current state:
- spam tax: >4 trades/hr penalty at 0.02/trade
- win rate floor: <10% penalised
- migration bonus weighted at 0.10
- Untried levers: survival threshold tightening, migration-only score multiplier, disqualification for genomes with 0 migration trades

### 2. src/genome/GenomeFactory.ts
Controls what genomes LOOK LIKE. Current state:
- capitalPct: 0.01-0.05
- noPumpBailMs: 30-120s (keep short — proven better)
- takeProfitPct: 0.10-2.0
- migration-biased: already high %
- Untried levers: push migration bias to 60-70%, tighten takeProfitPct range for migration genomes, increase mutation resistance

### 3. src/market/MarketFeed.ts
Controls what SIGNALS pass through. Current state:
- amm_activity min trade: 5 SOL
- amm_activity liq floor: 50 SOL estimated
- rate limit: 10/min
- Untried levers: separate migration signal cooldown, completely disable amm_activity for low-liquidity pools, add time-of-day filtering

### Liquidity policy
- Hard signal floors now apply before Darwin evaluates entries:
  - migration: 25 SOL
  - new_pool: 30 SOL
  - amm_activity: 50 SOL
  - whale_buy: 50 SOL
- Darwin also skips signals if the pool is too shallow to support a meaningful fraction of the intended position size.
- Do not weaken these guards unless the data clearly shows a better live-scalable rule.

## Signal types
- `migration`: Pump.fun token completing bonding curve → PumpSwap AMM. 2-6/hour. **This is where ALL the alpha is.** Average +200% on winning trades.
- `amm_activity`: Any swap >5 SOL. Very frequent. Low predictive value. Drag on performance.
- `whale_buy`: Buy >5 SOL. Medium frequency. Moderate confidence.

## Realistic simulation now active
Paper trading now simulates:
- 0.002 SOL fee per open + 0.002 SOL fee per close
- 18% failed transaction rate (Solana congestion)
- 1.5% extra slippage on entry vs quoted price
This means a strategy needs GENUINE edge to show positive score.

## Rules
1. ONE change per experiment. Never touch two files at once.
2. Must compile cleanly with `tsc`.
3. Never modify: types.ts, PaperExecutor.ts, BankrollManager.ts, Orchestrator.ts, Logger.ts, PopulationManager.ts
4. Choose the file to modify based on CURRENT metrics — if no_pump_bail is high, focus on MarketFeed or GenomeFactory. If win_rate is low, focus on FitnessScorer.
5. Prioritise changes that increase migration signal exposure and reduce amm_activity noise.
6. State hypothesis clearly before returning code.
7. Return ONLY the complete modified file. No markdown fences.
