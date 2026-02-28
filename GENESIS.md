# GENESIS.md — Darwin Trading Organism

> *"It is not the strongest of the species that survives, nor the most intelligent. It is the one most adaptable to change."*

---

## The Mission

**$200 → $100,000 in 30 days. Then $1,000,000/week.**

Starting capital: ~1 SOL (~$200 USDC).
This is a 500x in 30 days. It requires 3 legendary trades compounded, not 500 small wins.

```
COMPOUNDING ROADMAP

Week 1:  $200    → $2,000    (10x)  catch one clean migration pump
Week 2:  $2,000  → $20,000   (10x)  second pump, position still fits in pool
Week 3:  $20,000 → $100,000  (5x)   third trade — pool liquidity becomes the constraint
Week 4+: $100k/week → $1M/week      organism has found the apex strategy, size up
```

The path is narrow but real. Solana migrations regularly produce 10-50x in minutes.
The organism's job is to find the signal that precedes them before any other bot does.

---

## What This Is

Darwin is not a trading bot. It is a **digital organism** that learns to trade through evolution.

No strategy is hand-coded. No parameters are manually tuned. A population of candidate strategies is spawned, thrown into live market conditions, and left to compete. The ones that generate alpha survive and reproduce. The ones that lose get deleted — not paused, not archived, **deleted** — and replaced by offspring of the survivors.

The AI does not start as a trader. It becomes one.

---

## Core Philosophy

Traditional bots fail because humans encode their own biases into the strategy. We decide what signals matter, what timeframes to use, what exit logic to apply. We are the bottleneck.

Darwin removes the human from strategy design entirely. The genome encodes **what to look at**, **how to combine signals**, and **when to act**. Mutation explores combinations no human would think to try. The market itself is the only judge.

The only human decisions are:
1. What data the organism is allowed to see (the signal universe)
2. What fitness means (the selection pressure)
3. How much capital to risk per generation

Everything else is evolution.

---

## The Genome

Each strategy is a **living program** encoded as a directed acyclic graph (DAG) of signal nodes. This is not parameter tuning — the structure itself evolves.

### Signal Nodes (the gene pool)
```
PRICE GENES
  price_momentum(window)        — rate of change over N candles
  price_breakout(lookback)      — breach of N-period high/low
  price_mean_reversion(band)    — distance from rolling mean in stddev
  vwap_deviation(window)        — price vs volume-weighted average

VOLUME GENES
  volume_spike(multiplier)      — current vol vs N-period avg
  buy_pressure(window)          — buy vol / total vol ratio
  large_tx_count(threshold)     — number of txs above SOL threshold

ON-CHAIN GENES (Solana-specific)
  migration_signal()            — PumpFun to PumpSwap migration detected
  new_pool_age(max_ms)          — time since pool creation
  liquidity_depth(min, max)     — SOL liquidity band filter
  holder_concentration(max)     — top holder percent gate
  deployer_history(min_score)   — deployer wallet reputation
  first_buyers(n)               — is our wallet in first N buyers of pool

MOMENTUM GENES
  consecutive_green(n)          — N consecutive up candles
  acceleration(window)          — second derivative of price
  whale_entry(threshold)        — wallet above X SOL entering
  social_velocity()             — token mention spike (if feed available)

LOGIC OPERATORS (combinators)
  AND(a, b)                     — both signals true
  OR(a, b)                      — either signal true
  NOT(a)                        — signal inverted
  THRESHOLD(signal, value)      — signal crosses value
  SEQUENCE(a, b, delay)         — a then b within delay_ms
  WEIGHTED_SUM(signals, weights)— linear combination
```

### Exit Genome
Each strategy independently evolves its own exit logic:
```
EXIT GENES
  take_profit(pct)              — fixed target
  trailing_stop(activate, dist) — trail after activation pct
  time_stop(ms)                 — max hold duration
  fade_exit(giveback_pct)       — exit when pump reverses X pct
  no_pump_bail(ms)              — exit if no movement after entry
  moonbag(hold_pct)             — keep pct of position open
  ladder_exit(levels[])         — sell in tranches at multiple targets
```

### Risk Genome
```
RISK GENES
  capital_pct(pct)              — pct of current bankroll per trade (NOT fixed SOL)
  max_concurrent(n)             — open position limit
  drawdown_pause(pct, ms)       — pause after losing X pct of bankroll
  cooldown_ms(n)                — min time between entries
  liq_check(max_pct_of_pool)    — never enter if position > X pct of pool liq
```

Note: Risk genome uses **capital_pct not fixed SOL**. This is what enables compounding.
As the bankroll grows, position sizes grow automatically. This is how 10x becomes real.

---

## The Evolution Engine

### Population
- **Population size:** 32 concurrent strategy candidates
- **Minimum trades before evaluation:** 30
- **Generation cycle:** every 4 hours OR after 300 total trades, whichever comes first
- **Paper trading always on** for candidates below promotion threshold

### Fitness Function
The goal is $100k from $200. This changes everything about what fitness means.

We are NOT optimizing for Sharpe ratio. A strategy with a 5% win rate that catches 50x pumps
beats a strategy with a 60% win rate that grinds 3% per trade. The math is simple:

```
One 50x trade on 80% of bankroll = 40x your money.
One hundred 3% wins = 3x your money.

We need 50x trades, not 3% wins.
```

```
FITNESS SCORE = (
  upside_capture       x 0.35   # avg return on winning trades — THIS IS KING
  + best_trade_return  x 0.20   # can this strategy find a 10x+ move?
  + profit_factor      x 0.20   # gross wins / gross losses (not win rate)
  + trade_frequency    x 0.15   # fires enough to matter, not so much it noise-trades
  - max_drawdown_pct   x 0.10   # dont blow the bankroll before the big trade comes
)

DISQUALIFIERS (instant deletion regardless of score):
  - fewer than 30 trades after 4 hours (not firing = useless)
  - max_drawdown > 60% of bankroll in a single run (blowup risk)
  - best_trade_return < 20% after 100 trades (cannot catch pumps = useless for goal)
  - zero trades in last 2 hours during active market (dead signal)
```

Why `best_trade_return` matters: A strategy that has NEVER caught a 20%+ winner after 100
trades is provably not the organism we need. It gets deleted even if it is slightly profitable.
We are hunting for the genome that finds 10x+ moves. Everything else is noise.

### Selection
Each generation:
1. **Rank** all 32 strategies by fitness score
2. **Delete** the bottom 10 (no mercy, no archive)
3. **Preserve** the top 5 unchanged (elitism — protect what works)
4. **Breed** 10 new strategies from top performers (crossover)
5. **Mutate** 7 strategies from the survivor pool
6. **Spawn** 5 completely random new strategies (exploration)

### Crossover
Two parent strategies combine their signal graphs:
- Split point chosen randomly in the DAG
- Child inherits parent A entry logic + parent B exit logic
- OR parent A signal nodes + parent B logic operators
- Child risk genome is averaged from both parents with bias toward higher capital_pct

### Mutation Types
```
STRUCTURAL MUTATIONS (change what the strategy looks at)
  add_signal_node       — insert new signal into DAG
  remove_signal_node    — prune a leaf node
  swap_signal_type      — replace one signal gene with another
  rewire_connection     — change how nodes connect

PARAMETRIC MUTATIONS (change how sensitive)
  perturb_threshold     — adjust a signal trigger value +/- 20pct
  change_window         — shift a lookback period
  flip_operator         — AND to OR, NOT toggle

EXIT MUTATIONS (evolve how to ride the pump)
  add_exit_condition    — add a new exit gene
  remove_exit_condition — simplify exit logic
  swap_exit_type        — trailing to fade, time_stop to tp
  widen_trail           — give winners more room to run

MACRO MUTATIONS (rare, ~5% chance)
  full_entry_reset      — randomise entire entry genome
  full_exit_reset       — randomise entire exit genome
  cross_species_inject  — steal a node from a top performer
```

---

## Lifecycle: From Egg to Predator

```
STAGE 0 — PRIMORDIAL SOUP  (~Day 1-2)
  32 random organisms spawned
  All paper trading
  Signal graphs: 2-4 nodes, random connections
  Position size: 50% of bankroll per trade
  Goal: find any genome that can catch a 10x+ in paper

STAGE 1 — NATURAL SELECTION  (~Day 2-5)
  Organisms trade, die, breed
  Fitness scores computed each generation
  Bottom 10 deleted per cycle
  Bankroll clock is ticking — we have 30 days
  Goal: identify the signal combinations that precede big pumps

STAGE 2 — TRIAL BY FIRE  (~Day 5-10)
  Top 3 paper performers promoted to live trading
  Starting bankroll: ~1 SOL (~$200)
  Capital pct: 70% of bankroll per high-conviction signal
  Real slippage, real fees, real market impact
  Target by end of stage: $2,000
  Demotion trigger: live fitness drops below paper runner-up

STAGE 3 — PREDATOR EMERGENCE  (~Day 10-20)
  Surviving strategies proven on real money
  Capital pct scales to 60% at $2k-$20k range
  Position sizes now meaningful ($1,000-$10,000 per trade)
  Pool liquidity checks become critical
  Target by end of stage: $20,000
  Evolution continues in paper shadow alongside live

STAGE 4 — APEX  (~Day 20-30)
  Best strategy running live, sized for $20k-$100k range
  Capital pct: 40-50% (pool constraints bite above this)
  Multi-pool splitting if single position > 5% of pool liquidity
  Target by end of stage: $100,000
  Perpetual evolution continues — organism never stops
```

---

## The Compounding Protocol

This is the most important section. Getting the math right is what separates $100k from $3k.

```
BANKROLL STAGES AND POSITION SIZING

$200    - $2,000    capital_pct: 70-80%   — all-in mentality, small enough to hide
$2,000  - $20,000   capital_pct: 60-70%   — still aggressive, pools can absorb
$20,000 - $100,000  capital_pct: 40-50%   — pool liquidity starts constraining size
$100k+              capital_pct: 20-30%   — must split across pools, slower but safer

COMPOUNDING RULES
  - Never withdraw from bankroll during the 30 days
  - After each winning trade, full proceeds stay in bankroll
  - After a loss, next trade uses same capital_pct (no tilt sizing down)
  - After 3 consecutive losses, pause 30 minutes then resume
  - Max daily drawdown: 40% of peak bankroll — if hit, stop for 12 hours

POOL LIQUIDITY GATE
  Never enter if position_size > 8% of pool liquidity
  At $20k+: split trade across up to 3 pools if needed
  At $50k+: only trade pools with > $500k liquidity (or skip the trade)
```

---

## What "Deletion" Actually Means

When a strategy is deleted:
- Its genome is logged to `graveyard.jsonl` with final fitness score and cause of death
- Its trade history is preserved in `run.db` (for analytics)
- Its process is killed
- Its slot in the population is freed for a new candidate

The graveyard exists only for human analysis — to understand what the market rejected.
The organism itself does not mourn its dead. It breeds forward.

---

## Architecture

```
Orchestrator
  |-- PopulationManager         — maintains 32 strategy slots
  |    |-- spawn(genome)        — birth new organism
  |    |-- kill(strategy_id)    — delete + log to graveyard
  |    +-- promote(strategy_id) — paper to live promotion
  |
  |-- EvolutionEngine           — runs each generation cycle
  |    |-- score()              — compute fitness for all strategies
  |    |-- select()             — rank + cull bottom performers
  |    |-- breed(a, b)          — crossover two genomes
  |    |-- mutate(genome)       — random genome perturbation
  |    +-- spawn_random()       — generate new random organism
  |
  |-- SignalCompiler            — genome DAG to executable signal function
  |    +-- compile(genome)      — returns: (marketData) => TradeSignal
  |
  |-- MarketFeed                — real-time data stream all strategies share
  |    |-- PumpSwap WebSocket   — migration + AMM activity
  |    |-- PriceOracle          — SOL prices, pool reserves
  |    +-- OnChainScorer        — holder/deployer enrichment
  |
  |-- TradeExecutor             — shared execution layer
  |    |-- paper_trade()        — simulated with realistic slippage model
  |    +-- live_trade()         — real txs via Jito to Helius to RPC
  |
  |-- BankrollManager           — tracks real capital, enforces sizing rules
  |    |-- current_balance()    — live SOL balance from wallet
  |    |-- position_size()      — capital_pct x balance with liq gate
  |    +-- drawdown_check()     — halt if daily drawdown exceeded
  |
  +-- Observatory               — human visibility into the organism
       |-- generation_log.jsonl  — every generation scores + actions
       |-- graveyard.jsonl       — all deleted strategies + cause of death
       |-- champions.jsonl       — all-time top performers preserved
       |-- bankroll.jsonl        — every trade, running balance, compounding curve
       +-- live dashboard        — population fitness + bankroll chart in real time
```

---

## The Slippage Problem (Why Paper Does Not Equal Live)

Previous bots in this codebase suffered from inflated paper results because the simulator
assumed perfect fills on 600%+ pumps. Darwin addresses this directly.

```
simulated_exit_price = peak_price x (1 - slippage_model(pool_liq, position_size))

slippage_model:
  if position_size / pool_liq > 0.08:   impact = 20-50%   # kills the trade
  if position_size / pool_liq > 0.05:   impact = 10-20%   # painful
  if position_size / pool_liq > 0.02:   impact = 5-10%    # moderate
  if position_size / pool_liq < 0.01:   impact = 1-3%     # clean

  + random_noise(+/- 2%)                — market microstructure noise
  + latency_decay(entry_latency_ms)     — price moved while tx confirmed
  + jito_fee_estimate()                 — bundle tip cost
```

Paper fitness scores are haircut by 30% before promotion decisions.
A paper strategy must score 1.3x the threshold a live strategy must hold.
The bar for paper is harder than live, on purpose. No more phantom 600% fills.

---

## Rules

1. **No human encodes a strategy.** Signal combinations are the organisms job, not ours.
2. **Deletion is permanent.** Failed strategies are not paused, not archived for reuse, not mourned.
3. **Paper edge must survive live.** No strategy goes live without passing the haircut threshold.
4. **The fitness function is sacred.** Only change it if the metric itself is provably wrong.
5. **The organism is always running.** Complacency is extinction.
6. **Compound everything.** Every winning trade makes the next one bigger. This is the whole game.
7. **Respect pool liquidity.** Never be the trade that destroys its own exit.
8. **The clock is real.** 30 days. $200 to $100k. Evolution does not get extra time.

---

## Build Order (30-Day Sprint)

```
WEEK 1 — Make it breathe
  [ ] Genome TypeScript interfaces (SignalNode, ExitGenome, RiskGenome)
  [ ] SignalCompiler: DAG to live trading function
  [ ] PopulationManager: spawn / kill / promote 32 strategies
  [ ] Paper executor with slippage model
  [ ] Fitness scorer (upside_capture weighted)
  [ ] EvolutionEngine: score, select, breed, mutate
  [ ] BankrollManager: balance tracking + capital_pct sizing

WEEK 2 — Connect to the market
  [ ] PumpSwap WebSocket feed
  [ ] First full generation cycle with real signals
  [ ] graveyard.jsonl + generation_log.jsonl + bankroll.jsonl
  [ ] Inspect tooling: what genomes are surviving?
  [ ] Identify first promotion candidate

WEEK 3 — Real money
  [ ] Live trade promotion (paper to live)
  [ ] Jito/Helius execution
  [ ] Pool liquidity gate enforcement
  [ ] Auto-demotion if live fitness degrades
  [ ] Bankroll milestone: $200 to $2,000

WEEK 4 — Compound into the target
  [ ] Multi-pool splitting for large positions
  [ ] Live dashboard (bankroll curve + population heatmap)
  [ ] Genome lineage visualizer
  [ ] Bankroll milestone: $2,000 to $20,000+
  [ ] If alive: push toward $100,000
```

---

## Current State

**Status:** Pre-birth. Genome not yet implemented.
**Starting capital:** ~$200 USDC / ~1 SOL
**Bankroll today:** $200
**Target (Day 30):** $100,000
**Target (ongoing):** $1,000,000/week
**Days remaining:** 30
**Generations completed:** 0
**Strategies deleted:** 0
**Champions discovered:** 0
**Best trade ever:** none yet

*The primordial soup is ready. The clock is running. Begin.*

---
*Created: 2026-02-25*
*Author: Darwin Organism (via Claude)*
