# Project 1 Edge Iteration System

## Summary

Project 1 is not a single static thesis anymore.
It is an iterative PumpSwap edge-discovery program:

- collect real early-window pool data
- slice the data into cohorts
- measure post-cost exitability
- promote only the cohorts that survive repeated evidence
- kill weak or crowded cohorts quickly

This document exists to turn Project 1 into an engineering system rather than a fuzzy strategy debate.

The goal is not "prove strict-zero forever."
The goal is "find the smallest repeatable early-window cohort with positive, stable, post-cost expectancy."

## Core Thesis

Brand-new PumpSwap pools can create short-lived windows where:

- external buy competition is still low
- the pool is already tradable
- the creator setup is not obviously toxic
- later outside buyers still arrive

The edge is not necessarily the purest possible untouched pool.
The edge may be a narrower shape inside the early window, such as:

- `strict_zero`
- `sell_only_probe`
- `non_buy_noise`
- `one_buy_probe`
- `delayed_crowding`

The system should search those shapes empirically instead of assuming only one of them matters.

## Objective

Find one or more early-window cohorts that satisfy all of the following:

1. They occur often enough to matter.
2. They are tradable without upstream rent/ATA/setup failures.
3. They attract enough later buy flow to support exits.
4. Their realized or modeled post-cost expectancy is positive.
5. Their edge is stable across multiple runs, not one lucky sample.

## Non-Goals

- proving profitability from seeded or synthetic data
- full-auto live deployment before paper and canary evidence are clean
- treating all fresh pools as equivalent
- optimizing for signal count instead of expectancy

## Evidence Taxonomy

Every Project 1 result should be tagged as one of:

- `live_real`
- `historical_real`
- `seeded_fixture`

Only `live_real` and `historical_real` evidence may promote a cohort toward capital deployment.

## Iteration Loop

Each iteration follows the same loop.

1. Collect
- run the PumpSwap meta observer
- persist `pools-*`, `events-*`, rent audits, and canary outcomes
- record both accepted and rejected candidates

2. Slice
- group pools into cohort definitions
- examples:
  - `strict_zero`
  - `sell_only_probe`
  - `one_buy_probe`
  - `delayed_crowding`
  - liquidity buckets
  - creator uniqueness buckets
  - legitimacy buckets

3. Measure
- later buy flow rate
- `3+` later buy wallet rate
- reserve growth after first external interaction
- rent-safe / tradable rate
- creator-drain / toxicity rate
- modeled net edge after slippage, tips, and forced exit assumptions

4. Rank
- compare top-decile cohorts vs bottom-decile cohorts
- prefer monotonic relationships over anecdotal winners

5. Promote or Kill
- promote only cohorts with repeated positive evidence
- demote cohorts that fail expectancy, frequency, or execution quality

6. Tighten
- convert successful cohort definitions into canary admission logic
- convert failed cohort definitions into skip rules

## Promotion Ladder

Each cohort should move through this ladder:

1. `observed`
2. `measurable`
3. `paper_candidate`
4. `paper_positive`
5. `micro_canary_candidate`
6. `micro_canary_live`
7. `promoted`
8. `demoted`

Rules:

- `observed`: enough real pools exist to compute cohort metrics
- `measurable`: follow-on flow and tradability metrics are populated
- `paper_candidate`: cohort shows directionally positive post-cost expectancy
- `paper_positive`: repeated windows remain positive
- `micro_canary_candidate`: cohort survives paper plus execution screens
- `micro_canary_live`: tiny live trade path attempted
- `promoted`: repeated live or shadow evidence supports scaling
- `demoted`: cohort fails edge, execution, or stability gates

## Core Metrics

The system should optimize for these, in this order:

1. `tradable_rate`
- percentage of cohort pools that are actually entry-safe

2. `later_buy_flow_rate`
- any later non-creator buy within the follow-on window

3. `three_plus_later_buy_wallet_rate`
- stronger proxy for exit liquidity depth

4. `avg_reserve_delta_sol`
- reserve growth after the first external interaction

5. `toxicity_rate`
- creator drain, rent-blocked setup, repeat-creator spam, or similar poison

6. `expected_net_edge_pct`
- post-cost modeled edge, not raw return

7. `frequency`
- enough cohort occurrences per day or per run

## Current Known Cohorts

These should be treated as hypotheses, not truths:

- `strict_zero`
- `sell_only_probe`
- `liquidity_noise`
- `non_buy_noise`
- `one_buy_probe`
- `delayed_crowding`
- `low_buy_competition`
- `crowded`

These are now analyzable via:

```bash
cd /Users/benjijmac/Documents/Playground/darwinai
npm run analyze:pumpswap:alt-edges
```

After any live cyborg loss-floor report, run the same analyzer with the current break-even requirement before considering another live canary:

```bash
PUMPSWAP_ALT_EDGE_REQUIRED_GROSS_EDGE_PCT=2411.44 \
PUMPSWAP_ALT_EDGE_REQUIRE_LEGITIMATE_FOR_PROMOTION=true \
npm run analyze:pumpswap:alt-edges
```

This only produces offline promotion context. A cohort marked `PAPER_CANDIDATE` is still not live promotion proof; it only earns deeper paper/historical testing before a tiny canary.

If the observer has a usable `events-*.jsonl` file but no non-empty `pools-*.jsonl` summary, use the event-derived analyzer:

```bash
PUMPSWAP_EVENT_COHORT_REQUIRED_GROSS_EDGE_PCT=2411.44 \
PUMPSWAP_EVENT_COHORT_REQUIRE_LEGITIMATE_FOR_PROMOTION=true \
npm run analyze:pumpswap:event-cohorts
```

That script requires local PumpSwap observer outputs such as:

- `pools-*.json`
- `events-*.jsonl`
- `first-buyer-rent-audit-*.json`

Before any new live cyborg canary, run the replay-path analyzer against the same observer window with the current fixed live cost floor:

```bash
PUMPSWAP_REPLAY_FIXED_COST_SOL=0.00241144 \
PUMPSWAP_REPLAY_TRADE_SIZE_SOL=0.0001 \
PUMPSWAP_REPLAY_ENTRY_DELAY_MS=15000 \
PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS=3 \
npm run analyze:pumpswap:replay-paths
```

This estimates entry price, exit price, gross return, and modeled net return from observed reserve snapshots. A replay cohort marked `PAPER_CANDIDATE` is still not promotion proof; it only means the cohort may deserve deeper paper testing. A replay cohort marked `BLOCKED` must not be used for a paid live canary.

## System Architecture

### Layer 1: Collection

- `src/cli/pumpswapMetaObserver.ts`
- `scripts/ops/audit_pumpswap_first_buyer_rent.mjs`
- `scripts/ops/analyze_pumpswap_early_exitability.mjs`
- `scripts/ops/analyze_pumpswap_alt_edges.mjs`

Responsibilities:

- collect fresh pool creation and interaction events
- derive strict time anchors
- track first 5s and 10s competition windows
- audit first-buyer tradability
- persist raw outputs for later quant analysis

### Layer 2: Cohort Analysis

Responsibilities:

- classify pools into cohort shapes
- compute later-buy-flow and reserve-growth metrics
- compare cohorts on post-cost expectancy proxies
- emit machine-readable study artifacts

### Layer 3: Live Admission

- `src/observatory/cyborgShapeScoring.ts`
- `src/cli/cyborgCanary.ts`

Responsibilities:

- score candidate pools against the best current cohort priors
- enforce rent-safety and tradability preflight
- keep live sizing tiny until cohorts are proven

## Best Engineering Practices

### 1. Preserve Raw Data

Never replace raw observer outputs with only summaries.
Every study should keep:

- raw pool summaries
- raw interaction rows
- raw rent audits
- derived study outputs

Without that, new cohort ideas cannot be tested later.

### 2. Separate Data from Policy

The observer should record what happened.
The canary should decide what to trade.

Do not hardcode strategy assumptions into collection logic when they belong in scoring or promotion logic.

### 3. Make Rejections First-Class

The rejected candidate set is as important as the accepted set.
Project 1 likely hides edge in "almost good" pools, not only in fully accepted ones.

Every iteration should preserve:

- accepted pools
- rejected pools
- reason for rejection

### 4. Use Stable Artifact Contracts

Every study artifact should be machine-readable and versioned by timestamp.
Prefer:

- JSON for metrics and cohorts
- Markdown for readable summaries

### 5. Optimize for Reproducibility

Every study should be runnable from one command with env-overridable inputs.

### 6. Prefer Ranking over Hard Thresholds

Thresholds are useful for live admission.
Research should prefer cohort ranking and decile comparisons so we can discover non-obvious shapes.

### 7. Keep Live and Research Separate

Research mode should explore.
Canary mode should be conservative.

No cohort should jump directly from "interesting historical slice" to full live deployment.

### 8. Test the Classification Surface

Add tests whenever cohort logic changes:

- profile classification
- blocker logic
- scoring priors
- promotion rules

## Test Plan

### Unit Tests

- cohort classification from pool summaries
- metric aggregation per cohort
- canary score changes when cohort priors change
- tradability blocker handling

### Integration Tests

- observer outputs -> alt-edge analyzer -> artifact generation
- rent audit + pool summary + events -> follow-on flow metrics
- cohort promotion -> canary score update

### Acceptance Tests

Project 1 is only considered "advanced" when all are true:

- at least one non-seeded cohort is `paper_positive`
- that cohort has repeated positive later-flow and tradability metrics
- the micro-canary can observe and score that cohort live
- a micro-canary trade completes cleanly end to end

## Immediate Roadmap

1. Restore or repoint local PumpSwap observer artifacts so cohort analysis can run.
2. Run `analyze_pumpswap_alt_edges` on real historical data.
3. Compare alternate cohorts against `strict_zero`.
4. Promote the best non-seeded cohort into `cyborgShapeScoring`.
5. Keep live size tiny until one cohort survives repeated paper and micro-canary evidence.

## Current Honest Status

- Project 1 still has the strongest historical Solana-specific signal in this workspace.
- That signal is not yet validated as realized live profit.
- The next gain is likely to come from better cohort discovery, not from arguing about the original strict-zero framing.

## 2026-06-05 Break-Even-Aware Snapshot

Server report:

- `data/meta-observer/alt-edge-study-2026-06-05T14-42-10-977Z.json`
- Inputs: `pools-2026-06-05T13-16-06-840Z.jsonl`, `events-2026-06-05T13-16-06-840Z.jsonl`, `first-buyer-rent-audit-2026-06-05T14-37-06-737Z.json`
- Break-even requirement used: `2411.44%` gross-edge proxy, from the cleaner no-pool-extension `0.0001 SOL` live loss floor.

Result: no cohort is promotable.

Top cohort notes:

- `delayed_crowding`: `4` pools, rent-free rate `100%`, three-plus later-wallet rate `100%`, reserve-growth proxy `189.09%`; blocked by sample size, no legitimate-pool evidence, and edge proxy below break-even.
- `low_buy_competition`: `6` pools, rent-free rate `100%`, three-plus later-wallet rate `66.7%`, reserve-growth proxy `86.03%`; blocked by sample size, no legitimate-pool evidence, and edge proxy below break-even.
- `strict_zero`: `9` pools, rent-free rate `0%`, three-plus later-wallet rate `66.7%`, reserve-growth proxy `30.13%`; blocked by no rent-free first-buyer evidence, sample size, no legitimate-pool evidence, and edge proxy below break-even.

Interpretation: do not run another live canary from this cohort set. The next work is broader historical/paper search for a cohort whose modeled post-cost edge can plausibly clear the live loss floor.

## 2026-06-05 Event-Derived Broad Snapshot

Server report:

- `data/meta-observer/event-cohort-study-2026-06-05T14-47-27-866Z.json`
- Inputs: `events-2026-06-05T13-16-06-840Z.jsonl`, `events-2026-06-05T13-44-16-379Z.jsonl`, and both first-buyer rent audits generated from those windows.
- Scope: `167` event-derived pools, `63` with rent-audit coverage.
- Break-even requirement used: `2411.44%` gross-edge proxy.

Result: no cohort is promotable.

Top cohort notes:

- `delayed_crowding`: `10` pools, rent-free rate `60.0%`, three-plus later-wallet rate `100%`, reserve-growth proxy `130.31%`; blocked by sample size, no legitimate-pool evidence, and edge proxy below break-even.
- `low_buy_competition`: `33` pools, rent-free rate `93.9%`, three-plus later-wallet rate `93.9%`, reserve-growth proxy `123.58%`; blocked by no legitimate-pool evidence and edge proxy below break-even.
- `crowded`: `26` pools, rent-free rate `88.5%`, three-plus later-wallet rate `100%`, reserve-growth proxy `51.89%`; blocked by no legitimate-pool evidence and edge proxy below break-even.
- `strict_zero`: `25` pools, rent-free rate `0%`, three-plus later-wallet rate `88.0%`, reserve-growth proxy `40.56%`; blocked by no rent-free first-buyer evidence, no legitimate-pool evidence, and edge proxy below break-even.

Interpretation: broader flow confirms there is follow-on demand, but not enough modeled edge at the current tiny live cost floor. The next strategy rewrite should focus on reducing fixed execution cost, using pre-existing state/account paths, or finding a much stronger entry/exit model before any live canary.
