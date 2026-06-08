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

To search multiple entry/exit assumptions without rereading the full observer file for every hypothesis, use grid mode:

```bash
PUMPSWAP_REPLAY_FIXED_COST_SOL_LIST=0.000015966 \
PUMPSWAP_REPLAY_TRADE_SIZE_SOL=0.0001 \
PUMPSWAP_REPLAY_ENTRY_DELAY_MS_LIST=5000,10000,15000,30000,60000 \
PUMPSWAP_REPLAY_EXIT_AFTER_LATER_BUYS_LIST=1,2,3,5,10 \
PUMPSWAP_REPLAY_MAX_HOLD_MS_LIST=60000,180000,300000 \
npm run analyze:pumpswap:replay-paths
```

The `0.000015966 SOL` cost proxy is the median round-trip fee estimate from rent-safe first-buyer transactions in the widened five-minute audit below. It is not a Promotion Gate cost claim; it exists to separate true rent-safe execution friction from the prior failed canary's total market/strategy loss.

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

## 2026-06-08 Replay Grid Snapshot

Server reports:

- Widened rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T03-35-51-844Z.json`
- Full loss-floor replay: `data/meta-observer/replay-path-study-2026-06-08T03-38-06-067Z.json`
- Rent-safe fee-proxy replay: `data/meta-observer/replay-path-study-2026-06-08T03-43-46-978Z.json`
- Replay grid: `data/meta-observer/replay-path-grid-study-2026-06-08T03-49-11-532Z.json`

Widened rent audit inputs and result:

- Events: `data/meta-observer/events-2026-06-05T14-51-37-753Z.jsonl`
- Window: `300000 ms`
- First-buyer pools checked: `2540`
- Transactions found: `2540`
- Without pool-extension: `2026`
- With pool-extension: `514`
- Without ATA create: `2540`
- Median rent-safe first-buyer fee: `7983 lamports`
- Median round-trip fee proxy: `0.000015966 SOL`

Full loss-floor replay:

- Cost: `0.00241144 SOL`
- Pools: `2730`
- Completed paths: `2636`
- Rent-audited pools: `2603`
- Result: all profiles `BLOCKED`

Rent-safe fee-proxy replay:

- Cost: `0.000015966 SOL`
- Result: all single-assumption profiles still `BLOCKED`
- `strict_zero`: `419` pools, `408` completed paths, `88.5%` rent-tradable rate, `43.6%` win rate, `-3.74%` median modeled net.

Replay grid:

- Scenarios: `75`
- Paper candidates found: `9`
- All paper candidates were `strict_zero` with `exitAfterLaterBuys=10`.

Best current paper candidate:

- Profile: `strict_zero`
- Entry delay: `10000 ms`
- Exit rule: wait for `10` later non-creator buy wallets
- Max hold: `60000 ms`
- Cost proxy: `0.000015966 SOL`
- Pools: `419`
- Completed paths: `408`
- Rent-tradable rate: `88.5%`
- Win rate: `68.6%`
- Median modeled net return: `26.51%`
- Status: `PAPER_CANDIDATE`

Interpretation: this is the first evidence-backed strategy shape worth implementing in canary logic, but it is not live promotion proof. The cyborg canary now records the exit rule in `strategyConfig` and can wait for "10 later buyers or max-hold, then sell" when explicitly configured with `PUMPSWAP_CYBORG_EXIT_AFTER_LATER_BUYS=10` and `PUMPSWAP_CYBORG_MAX_HOLD_MS=60000`. Do not run another paid canary until that exact behavior is paper/shadow verified against fresh observer data.

Dry-run verification command:

```bash
PUMPSWAP_CYBORG_DRY_RUN=true \
PUMPSWAP_CYBORG_DRY_RUN_PREFLIGHT=true \
PUMPSWAP_CYBORG_EXECUTION_DEFER_MS=10000 \
PUMPSWAP_CYBORG_EXIT_AFTER_LATER_BUYS=10 \
PUMPSWAP_CYBORG_MAX_HOLD_MS=60000 \
PUMPSWAP_CYBORG_DRY_RUN_FIXED_COST_SOL=0.000015966 \
PUMPSWAP_CYBORG_CANARY_TIMEOUT_MS=300000 \
npm run run:cyborg:canary
```

Dry-run artifacts are written as `cyborg-dry-run-*.json` and must not be counted as Promotion Gate loops. They only prove live observer selection, optional non-trading entry tradability preflight, delayed-exit waiting behavior, and modeled reserve-snapshot economics without opening a wallet position.

### Fresh Dry-Run Evidence

Server artifact:

- `data/meta-observer/cyborg-dry-run-2026-06-08T04-00-40-155Z.json`

Result:

- Pool: `G552suKEmgYPqoYSVnmgCxHDeEDPXG2X8yJXzhTd8e3Q`
- Mint: `4RmZQtx4cxMdSkUrZHVh6BBtssrfbt9neoRcRasp7ykQ`
- Profile: `strict_zero`
- Shape score: `93`
- Entry defer: `10000 ms`
- Exit rule: wait for `10` later non-creator buy wallets, max hold `60000 ms`
- Exit reason: `later_buy_threshold`
- Observed later buy wallets at exit: `10`
- Exit wait: `31770 ms`
- Dry run: `true`
- State-rent setup allowed: no ATA create, no pool extension

Interpretation: the replay-backed `strict_zero` delayed-exit candidate can be selected from the fresh live observer stream and can reach its delayed exit condition without opening a wallet position. This is a paper/shadow gate improvement only. It is not live profit proof, not a Promotion Gate loop, and must not be used for capital scaling.

### Fresh Modeled Dry-Run Evidence

Server artifact:

- `data/meta-observer/cyborg-dry-run-2026-06-08T04-07-09-068Z.json`

Result:

- Pool: `41gcoATtgFGoMxwTRtGwGHDJWkiaEikX1Qo1q44hsiX7`
- Mint: `Fcxktk2nkQ16nhcu9C3q5oeT41QbmKZMWwVZjsnoAHSY`
- Profile: `strict_zero`
- Shape score: `93`
- Entry defer: `10000 ms`
- Exit rule: wait for `10` later non-creator buy wallets, max hold `60000 ms`
- Exit reason: `later_buy_threshold`
- Observed later buy wallets at exit: `10`
- Exit wait: `16066 ms`
- Modeled entry price: `0.00006011890684369555 SOL`
- Modeled exit price: `0.00008863923232662902 SOL`
- Modeled gross return: `47.43986040378958%`
- Modeled fixed cost: `0.000015966 SOL`
- Modeled net return: `31.47386040378958%`
- Modeled net SOL at `0.0001 SOL` size: `0.00003147386040378958 SOL`
- Dry run: `true`
- State-rent setup allowed: no ATA create, no pool extension

Interpretation: the fresh live stream produced one non-trading sample whose reserve-snapshot path would have cleared the rent-safe fixed-cost proxy. This is stronger than the prior dry run because it records modeled entry, modeled exit, gross return, cost proxy, and modeled net. It is still not Promotion Gate proof because no real buy, real sell, wallet delta, finality check, or flattening occurred.

### Repeated Dry-Run Stop Signal

Additional server artifacts from the same frozen dry-run config:

- `data/meta-observer/cyborg-dry-run-2026-06-08T04-12-45-477Z.json`
- `data/meta-observer/cyborg-dry-run-2026-06-08T04-15-04-032Z.json`
- `data/meta-observer/cyborg-dry-run-2026-06-08T04-18-37-218Z.json`

Modeled dry-run summary, excluding the first pre-modeled dry-run:

- Modeled samples: `4`
- Modeled wins: `3`
- Modeled losses: `1`
- Win rate: `75.0%`
- Median modeled net: `56.0832972076497%`
- Min modeled net: `-11.701430068772698%`
- Max modeled net: `87.38174390670272%`

The loss was `data/meta-observer/cyborg-dry-run-2026-06-08T04-18-37-218Z.json`:

- Pool: `3tbxGEhPhQgJaEThTFHvzfSgReuDYkZt8hcf1Xo6MQTq`
- Exit reason: `max_hold`
- Later buy wallets observed: `9`
- Exit wait: `60213 ms`
- Modeled gross return: `4.264569931227302%`
- Modeled net return: `-11.701430068772698%`

Interpretation: the exact `exitAfterLaterBuys=10`, `maxHold=60000 ms` dry-run config is not ready for a funded canary. A single modeled max-hold loss is enough to keep live locked because Promotion Gate requires repeatable net-positive live round trips, not a best-case sample.

### Current-Window Rent Audit and Replay Grid

Current-window rent audit:

- Audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T04-20-39-395Z.json`
- Events: `data/meta-observer/events-2026-06-08T03-29-38-002Z.jsonl`
- Window: `300000 ms`
- First-buyer pools checked: `107`
- Transactions found: `107`
- With pool extension: `13`
- Without pool extension: `94`
- Rent-free first buyer possible: `true`

Current-window replay grid with the current rent audit:

- Grid: `data/meta-observer/replay-path-grid-study-2026-06-08T04-21-06-744Z.json`
- Scenarios: `24`
- Best current strict-zero scenario: `entry=10000 ms`, `exitAfterLaterBuys=9`, `maxHold=30000 ms`
- Pools: `14`
- Completed paths: `14`
- Rent-tradable rate: `85.7%`
- Win rate: `71.4%`
- Median modeled net: `57.4889993537714%`
- Average modeled net: `47.6004993580729%`
- Status: `BLOCKED`
- Blocker: `sample_pools<20`

The current configured canary-like scenario, `entry=10000 ms`, `exitAfterLaterBuys=10`, `maxHold=60000 ms`, also remains blocked:

- Pools: `14`
- Completed paths: `14`
- Rent-tradable rate: `85.7%`
- Win rate: `71.4%`
- Median modeled net: `56.0832972076497%`
- Average modeled net: `43.749821729260326%`
- Status: `BLOCKED`
- Blocker: `sample_pools<20`

Decision: no funded live canary from this evidence yet. Keep the PumpSwap meta observer running, collect at least `20` current-window strict-zero paths with current rent audit coverage, rerun the replay grid, then only consider a tiny funded `0.0001 SOL` canary if the frozen config has no unresolved modeled stop signal and the current-window grid clears its blockers.

### Entry-Preflight Dry-Run Scan

Code update:

- `PUMPSWAP_CYBORG_DRY_RUN_PREFLIGHT=true` makes dry-run mode run the same live entry tradability preflight before waiting for the modeled exit.
- Dry-run still does not open a wallet position or submit a transaction.
- If no preflight-tradable candidate executes before timeout, the run now writes `cyborg-dry-run-scan-*.json`.

Server scan:

- Scan: `data/meta-observer/cyborg-dry-run-scan-2026-06-08T04-40-58-526Z.json`
- Dry-run preflight: `true`
- Live signal max age: `90000 ms`
- Timeout: `300000 ms`
- Executed dry-run candidate: none

Strict-zero candidates blocked by live entry preflight:

- Pool `2RX1NvmfjjePkojfPVDJo1ZEFacmsLDaxUCoMtaFrWwn`: `state_rent_blocked:pool_extend`
- Pool `2PqzZiA9QJGTCAAsQsZWUrNpxwPZNE3s7b7sdBFbgBkX`: `state_rent_blocked:ata_create`

Other skipped candidates:

- One crowded profile with early buy/interactions.
- One low-competition profile with non-zero interactions.

Interpretation: the prior modeled-only dry-run evidence was too weak because it assumed candidates were entry-tradable. With the live entry preflight enabled, the current stream produced no tradable strict-zero candidate in the bounded run. Live remains locked. The next valid proof step is more preflight-enabled dry-run scanning, not funded execution.

### Second Entry-Preflight Dry-Run Scan

Server scan:

- Scan: `data/meta-observer/cyborg-dry-run-scan-2026-06-08T04-47-25-456Z.json`
- Dry-run preflight: `true`
- Live signal max age: `90000 ms`
- Timeout: `300000 ms`
- Executed dry-run candidate: none

Strict-zero candidate blocked by live entry preflight:

- Pool `B4AQ8WVBhrF1oQ6LxicRPCeuApLx8nDoDufFXCDDSkoH`: `state_rent_blocked:pool_extend`

Other skipped candidates:

- Nine low-competition or crowded profiles failed the frozen strict-zero shape gate.

Interpretation: this second preflight-enabled scan again found no preflight-tradable strict-zero candidate. The repeated blocker is not lack of modeled upside; it is live entry eligibility under the no-state-rent rule. Live remains locked.

### Promotion-Aligned ATA Preflight Dry-Run

The promotion batch runner uses `DARWIN_LIVE_ALLOW_ATA_CREATE=true` and `DARWIN_LIVE_CLOSE_TOKEN_ATA_ON_SELL=true`, while keeping pool extension blocked unless explicitly overridden for diagnostics. The prior preflight scans were stricter than the actual promotion-batch config because they also blocked ATA creation.

Server dry-run:

- Artifact: `data/meta-observer/cyborg-dry-run-2026-06-08T04-51-45-286Z.json`
- Dry-run preflight: `true`
- Live signal max age: `90000 ms`
- ATA create allowed: `true`
- Close token ATA on sell: `true`
- Pool extension allowed: `false`
- Entry tradability preflight: `tradable=true`

Result:

- Pool: `4ZkFBLu2Fn9SovDbRL5vyFHe37X2X44uoK18eUjJaPtx`
- Mint: `5k9ZcNsd2iotCnt6Qhd35e17WtVqJMDEDnwYyqJiQ1To`
- Profile: `strict_zero`
- Shape score: `93`
- Exit reason: `later_buy_threshold`
- Later buy wallets observed: `10`
- Exit wait: `11595 ms`
- Modeled gross return: `3.4255985803460565%`
- Modeled fixed cost: `0.000015966 SOL`
- Modeled net return: `-12.540401419653943%`
- Modeled net SOL at `0.0001 SOL` size: `-0.000012540401419653945 SOL`

Interpretation: promotion-aligned preflight can find an entry-tradable strict-zero candidate when ATA creation is allowed and close-on-sell is enabled, but the first such candidate was modeled-negative after the fixed-cost proxy. This is a stronger stop signal than the entry-blocked scans: the current strategy is not ready for funded canary even under the promotion-batch state-rent policy.

### Wider Replay Candidate and Low-Competition Dry-Run Scan

Server replay refresh:

- Rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T04-53-44-015Z.json`
- Replay grid: `data/meta-observer/replay-path-grid-study-2026-06-08T04-54-16-761Z.json`
- Scope: `161` first-buyer pools checked; `142` without pool extension; `19` with pool extension.

Best paper candidates from the wider grid:

- `low_buy_competition`, `entry=5000 ms`, `exitAfterLaterBuys=9`, `maxHold=45000/60000 ms`: `35` pools, `32` completed, `97.14%` rent-safe rate, `75.0%` win rate, `+3.63%` median modeled net, `+8.03%` average modeled net, status `PAPER_CANDIDATE`.
- `low_buy_competition`, `entry=5000 ms`, `exitAfterLaterBuys=3`, `maxHold=15000-60000 ms`: `35` pools, `71.9%` win rate, `+5.21%` median modeled net, `+23.66%` average modeled net, status `PAPER_CANDIDATE`.
- `strict_zero`, `entry=5000 ms`, `exitAfterLaterBuys=12`, `maxHold=15000/30000/45000 ms`: `20` pools, `70.0%` win rate, `+51.29%` median modeled net, `+49.16%` average modeled net, `95.0%` rent-safe rate, status `PAPER_CANDIDATE`.

Strict-zero mutation dry-run:

- Artifact: `data/meta-observer/cyborg-dry-run-2026-06-08T04-57-15-303Z.json`
- Entry tradability preflight: `tradable=true`
- Profile: `strict_zero`
- Exit rule: `exitAfterLaterBuys=12`, `maxHold=15000 ms`
- Exit wait: `4014 ms`
- Modeled gross return: `0.2388%`
- Modeled net return: `-15.727%`

Latest low-competition dry-run scan:

- Artifact: `data/meta-observer/cyborg-dry-run-scan-2026-06-08T05-07-02-256Z.json`
- Timeout: `300000 ms`
- Config: `maxBuyCompetitors5s=1`, `maxInteractions5s=2`, `exitAfterLaterBuys=3`, `maxHold=15000 ms`, ATA create allowed, pool extension blocked.
- Executed dry-run candidate: none
- Skipped low-exitability candidates: `16`
- Upstream-blocked candidates: `2`
- Upstream blocker reasons: `state_rent_blocked:pool_extend`, `state_rent_blocked:pool_extend`

Interpretation: the wider replay found paper candidates, but the first strict-zero mutation turned negative under current modeled costs, and the first low-competition live scan could not produce a preflight-tradable, sufficiently clean candidate inside five minutes. The current evidence supports more paper/preflight iteration, not funded live trading.

### Relaxed Low-Competition Preflight Dry-Run

Server dry-run:

- Artifact: `data/meta-observer/cyborg-dry-run-2026-06-08T05-10-52-915Z.json`
- Config: `minScore=58`, `maxBuyCompetitors5s=1`, `maxInteractions5s=12`, `exitAfterLaterBuys=3`, `maxHold=15000 ms`
- State-rent policy: ATA create allowed, pool extension blocked, close token ATA on sell enabled
- Entry tradability preflight: `tradable=true`

Result:

- Pool: `FkZSNStekeDH2riXvq1sHPw2FG1Ge1xizyrVLJJb2LfR`
- Mint: `82jnnxZ3gA5b99usFBJuUtT1T9ikiPKGirEotYnNdoQa`
- Profile: `low_competition`
- Shape score: `70`
- Exit reason: `max_hold`
- Later buy wallets observed: `2`
- Exit wait: `15162 ms`
- Modeled gross return: `0.07421007592069984%`
- Modeled fixed cost: `0.000015966 SOL`
- Modeled cost on `0.0001 SOL` size: `15.966%`
- Modeled net return: `-15.8917899240793%`
- Modeled net SOL at `0.0001 SOL` size: `-0.0000158917899240793 SOL`

Interpretation: relaxing the scorer to the low-competition paper profile did produce a preflight-tradable candidate without pool extension, but the first executed dry-run was clearly negative after the fixed-cost proxy. This config cannot justify funded live canary without stronger repeated dry-run evidence or a materially lower cost floor.

### Longer-Hold Low-Competition Preflight Dry-Run

Server dry-run:

- Artifact: `data/meta-observer/cyborg-dry-run-2026-06-08T05-13-53-755Z.json`
- Config: `minScore=58`, `maxBuyCompetitors5s=1`, `maxInteractions5s=12`, `exitAfterLaterBuys=9`, `maxHold=45000 ms`
- State-rent policy: ATA create allowed, pool extension blocked, close token ATA on sell enabled
- Entry tradability preflight: `tradable=true`

Result:

- Pool: `D5Kfm145rqLvk24D9THg1b5ZUJayY4kE6ubFXiiPPaSW`
- Mint: `HJYvThMadW7ojhRQJNU3icyixnYg5P5mx33DarUG3LTk`
- Profile: `low_competition`
- Shape score: `58`
- Exit reason: `later_buy_threshold`
- Later buy wallets observed: `9`
- Exit wait: `9573 ms`
- Modeled gross return: `-23.593046669534278%`
- Modeled fixed cost: `0.000015966 SOL`
- Modeled cost on `0.0001 SOL` size: `15.966%`
- Modeled net return: `-39.559046669534276%`
- Modeled net SOL at `0.0001 SOL` size: `-0.00003955904666953428 SOL`

Interpretation: the longer-hold paper candidate did not survive live-window dry-run evidence either. It reached the later-buyer threshold quickly, but price moved against the modeled entry before costs. The low-competition profile is not promotion-ready under either tested exit variant.

### Fresh Current-Window Frontier and Preflight Recheck

The earlier broad grid was too expensive when it included all historical event files, including the multi-GB June 5 observer file. The current-window replay was rerun explicitly against the active June 8 observer stream.

Fresh current-window rent audit:

- Audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T05-35-24-070Z.json`
- Events file: `data/meta-observer/events-2026-06-08T03-29-38-002Z.jsonl`
- First-buyer pools in window: `136`
- Transactions found: `136`
- With pool extension: `12`
- Without pool extension: `124`

Focused current-window replay grid:

- Grid: `data/meta-observer/replay-path-grid-study-2026-06-08T05-36-14-019Z.json`
- Scenarios: `120`
- Cost proxy: `0.000015966 SOL` at `0.0001 SOL` size

Fresh replay result:

- `strict_zero` still shows large modeled returns, but is `BLOCKED` because the refreshed audit gives `0` rent-tradable coverage for that profile. Best strict-zero examples show median modeled net around `34.70%`, win rate `67.65%`, and blocker `no_rent_free_first_buyer_evidence`.
- Best promotion-aligned paper candidate left: `low_buy_competition`, `entry=5000 ms`, `exitAfterLaterBuys=12`, `maxHold=15000/45000/60000 ms`, `64` pools, `59` completed, `95.31%` rent-tradable rate, `69.49%` win rate, median modeled net `+2.8787%`.

Strict-zero preflight scan:

- Artifact: `data/meta-observer/cyborg-dry-run-scan-2026-06-08T05-34-29-066Z.json`
- Config: `minScore=70`, `maxBuyCompetitors5s=0`, `maxInteractions5s=0`, `exitAfterLaterBuys=10`, `maxHold=30000 ms`
- State-rent policy: ATA create allowed, pool extension blocked, close token ATA on sell enabled
- Executed dry-run candidate: none
- Skipped low-exitability candidates: `6`
- Upstream-blocked candidates: `7`
- Upstream blocker: all `7` were `state_rent_blocked:pool_extend`

Low-competition exit-12 preflight dry-run:

- Artifact: `data/meta-observer/cyborg-dry-run-2026-06-08T05-42-16-304Z.json`
- Config: `minScore=58`, `maxBuyCompetitors5s=1`, `maxInteractions5s=12`, `exitAfterLaterBuys=12`, `maxHold=15000 ms`
- Entry tradability preflight: `tradable=true`
- Pool: `GcgNfoq7hHCYq1vYifANbtoXv1KdgMSLNeferd5hW1sQ`
- Mint: `DJfxEAEc8JU1Jf4yajYwi4Qma5Jb2qgYmxkoUctEpump`
- Profile: `low_competition`
- Shape score: `70`
- Exit reason: `max_hold`
- Later buy wallets observed: `8`
- Exit wait: `15090 ms`
- Modeled gross return: `-1.0336084969648773%`
- Modeled cost on `0.0001 SOL` size: `15.966%`
- Modeled net return: `-16.999608496964875%`
- Modeled net SOL at `0.0001 SOL` size: `-0.000016999608496964877 SOL`

Interpretation: the current-window search found no promotion-ready path. Strict-zero has modeled edge but repeatedly fails live entry eligibility under the no-pool-extension rule. The only current rent-tradable paper candidate has thin replay edge and produced another negative preflight dry-run. Live remains locked; the next strategy/search rewrite should either predict and avoid pool-extension-required strict-zero pools before preflight, or search for a materially stronger no-pool-extension profile than low competition.

### Tightened Replay Promotion Thresholds

Code change:

- Commit: `618e57a Tighten replay promotion thresholds`
- Added replay options:
  - `PUMPSWAP_REPLAY_MIN_RENT_TRADABLE_RATE`
  - `PUMPSWAP_REPLAY_MIN_MEDIAN_MODELED_NET_RETURN_PCT`
  - `PUMPSWAP_REPLAY_MIN_AVG_MODELED_NET_RETURN_PCT`
- Tests: local `npm test` passed `76/76`.

Reason: the old offline replay gate could label a profile as `PAPER_CANDIDATE` with any rent-free evidence and any positive modeled median/average. The live evidence showed that was too weak: strict-zero had modeled edge but repeatedly hit `pool_extend`, while low competition had thin modeled edge and then produced negative dry-runs.

Strict current-window replay:

- Grid: `data/meta-observer/replay-path-grid-study-2026-06-08T05-47-35-728Z.json`
- Events file: `data/meta-observer/events-2026-06-08T03-29-38-002Z.jsonl`
- Rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T05-35-24-070Z.json`
- Scenarios: `120`
- Cost proxy: `0.000015966 SOL` at `0.0001 SOL` size
- Minimum win rate: `0.65`
- Minimum rent-tradable rate: `0.90`
- Minimum median modeled net: `15%`
- Minimum average modeled net: `15%`
- Paper candidates: `0`

Top blocked profiles:

- `strict_zero`, best median modeled net around `34.6999%`, but rent-tradable rate `0`, blocked by `no_rent_free_first_buyer_evidence` and `rent_tradable_rate<0.9`.
- `low_buy_competition`, best current-window rows around `2.49%` to `4.08%` median modeled net, blocked by the new modeled-margin thresholds.

Interpretation: after requiring both no-pool-extension coverage and a real modeled margin, the current observer window has no paper candidate worth another funded canary. Live remains locked. The next useful mutation is not parameter tuning around the current profiles; it is a new profile/search feature that combines no-pool-extension eligibility with materially stronger post-cost exitability.

### Rent-Seeded Cyborg Selector

Code change:

- Commit: `72f3666 Add rent-seeded cyborg selector`
- Added `PUMPSWAP_CYBORG_SCORER_MIN_BUY_COMPETITORS_5S`.
- Added the field to `strategyConfig.scorer` so promotion evidence and known-loss preflights fingerprint the selector.
- Added visible canary startup logging: `minBuy5s=...`.
- Tests: local `npm test` passed `77/77`.

Reason: strict-zero pools repeatedly showed strong modeled returns but failed live entry preflight with `state_rent_blocked:pool_extend`. The rent-seeded selector lets Darwin require at least one non-creator buy in the first five seconds, so Darwin is not trying to be the first setup actor on a pool that likely needs extension.

Rent-seeded dry-run scan:

- Artifact: `data/meta-observer/cyborg-dry-run-scan-2026-06-08T06-01-53-226Z.json`
- Config: `minScore=70`, `minBuyCompetitors5s=1`, `maxBuyCompetitors5s=1`, `maxInteractions5s=2`, `exitAfterLaterBuys=12`, `maxHold=15000 ms`
- State-rent policy: ATA create allowed, pool extension blocked, close token ATA on sell enabled
- Timeout: `600000 ms`
- Executed dry-run candidate: none
- Skipped low-exitability candidates: `17`
- Upstream-blocked candidates: `0`
- Profile counts: `crowded=5`, `low_competition=11`, `strict_zero=1`
- Blocker counts: `buy_competitors_5s>1=5`, `interactions_5s>2=15`, `buy_competitors_5s<1=12`, `repeat_creator=5`, `liquidity_sol<20=5`

Interpretation: the selector correctly avoids strict-zero/no-seed pools and does not hit pool-extension preflight blockers, but exact-one-buy plus very-low-noise candidates were too sparse in this 10-minute live stream. Live remains locked. The next search mutation should explore rent-seeded variants with measured tradeoffs, such as allowing slightly more interactions only if replay shows a materially higher post-cost edge and the no-pool-extension rate remains high.

### Rent-Seeded Low-Noise Replay Split

Code change:

- Commit: `6336c20 Split rent seeded low-noise replay profile`
- Added replay profile `rent_seeded_low_noise` for pools with exactly one early non-creator buy and up to five early interactions.
- Kept `one_buy_probe` for the stricter exactly-one-buy, at-most-two-interactions case.
- Tests: local `npm test` passed `78/78`.

Reason: after the rent-seeded live selector found no exact-one-buy, very-low-noise candidate in 10 minutes, the next question was whether slightly more early noise still had enough modeled edge. The old `low_buy_competition` bucket was too broad to answer that.

Strict current-window replay:

- Grid: `data/meta-observer/replay-path-grid-study-2026-06-08T06-06-27-438Z.json`
- Events file: `data/meta-observer/events-2026-06-08T03-29-38-002Z.jsonl`
- Rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T05-35-24-070Z.json`
- Scenarios: `120`
- Minimum rent-tradable rate: `0.90`
- Minimum median modeled net: `15%`
- Minimum average modeled net: `15%`
- Paper candidates: `0`

Profile outcomes:

- `rent_seeded_low_noise`: `1` pool, rent-tradable rate `100%`, win rate `0%`, best median modeled net `-0.223%`, blocked by `sample_pools<20`, modeled-margin blockers, and `win_rate<0.65`.
- `one_buy_probe`: no rows in the current grid.
- `delayed_crowding`: `22` pools, rent-tradable rate `81.82%`, best median modeled net `-7.0931%`, blocked by rent-tradable, modeled-margin, and win-rate blockers.
- `low_buy_competition`: `72` pools, rent-tradable rate `84.72%`, best median modeled net around `4.0091%`, blocked by rent-tradable and modeled-margin blockers.
- `strict_zero`: still has high modeled return, but rent-tradable rate `0` and remains blocked by no rent-free first-buyer evidence.

Interpretation: the measured rent-seeded variants do not produce a promotion-ready candidate in the current observer window. There is no justified dry-run or funded canary from these profiles. Live remains locked. The next search rewrite should move beyond first-five-second shape alone and add a stronger predictor, such as creator/pool metadata, reserve trajectory, or a post-entry momentum filter that can be replayed before any live path.

### Replay Segment Momentum Grid

Code change:

- Commit: `fb2e498 Add replay segment momentum analysis`
- Replay paths now record first-5-second buy/interact counts, pre-entry buy/interact counts, and entry momentum from pool creation price to entry price.
- Replay reports now include `bySegment`, grouping profile, rent eligibility, entry-momentum band, pre-entry buy band, and pre-entry interaction band under the same strict promotion blockers.
- Tests: local `npm test` passed `79/79`.

Reason: first-five-second profile alone was not enough. Strict-zero had modeled edge but was not executable without pool extension, while rent-seeded and low-competition variants were either sparse or too thin after costs. Segmenting by entry momentum and pre-entry crowding tests whether a stronger no-pool-extension subgroup exists before spending another live canary.

Current-window segment replay:

- Grid: `data/meta-observer/replay-path-grid-study-2026-06-08T06-14-55-859Z.json`
- Events file: `data/meta-observer/events-2026-06-08T03-29-38-002Z.jsonl`
- Rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T05-35-24-070Z.json`
- Scenarios: `120`
- Paper profile candidates: `0`
- Paper segment candidates: `0`

Combined audited-window segment replay:

- Grid: `data/meta-observer/replay-path-grid-study-2026-06-08T06-16-55-007Z.json`
- Events files: `events-2026-06-05T13-16-06-840Z.jsonl`, `events-2026-06-05T13-44-16-379Z.jsonl`, `events-2026-06-08T03-29-38-002Z.jsonl`
- Rent audits: `first-buyer-rent-audit-2026-06-05T14-37-06-737Z.json`, `first-buyer-rent-audit-2026-06-05T14-47-04-759Z.json`, `first-buyer-rent-audit-2026-06-08T05-35-24-070Z.json`
- Scenarios: `120`
- Paper profile candidates: `0`
- Paper segment candidates: `0`

Best 20-plus-pool rent-safe segment:

- Segment: `profile=low_buy_competition|rent=yes|entry_momentum=0_to_10_pct|pre_entry_buys=1|pre_entry_interactions=6_to_10`
- Best sample: `31` pools, `30` completed paths, rent-tradable rate `100%`
- Best win rate: `93.33%`
- Best median modeled net in the 20-plus-pool rent-safe set: `12.10%`
- Blocker: `median_modeled_net_return_pct<=15`

Best edge-shaped but undersampled segment:

- Segment: `profile=crowded|rent=yes|entry_momentum=0_to_10_pct|pre_entry_buys=3_to_5|pre_entry_interactions=11_plus`
- Sample: `13` pools, `9` completed paths, rent-tradable rate `100%`
- Best median modeled net: `20.68%`
- Best win rate variant: `88.89%`
- Blocker: `sample_pools<20`

Interpretation: the segment mutation found a better research target, but not a spendable strategy. The strongest adequately sampled rent-safe segment has strong win rate and average return, but its median net is below the required `15%` margin. The segment that clears modeled edge is only `13` pools and remains an overfit risk. Live remains locked. The next valid work is to either collect enough fresh audited samples for the crowded rent-safe segment to reach `20` pools, or add a stronger feature that lifts the median of the 20-plus-pool rent-safe segment above the cost floor.

### Replay Liquidity Segment Grid

Code change:

- Commit: `ea76ca1 Add replay liquidity segment features`
- Replay paths now record initial SOL liquidity, entry SOL liquidity, and entry liquidity growth before the modeled entry.
- Replay segments now include initial-liquidity band and entry-liquidity-growth band, in addition to profile, rent eligibility, entry momentum, pre-entry buys, and pre-entry interactions.
- Tests: local `npm test` passed `79/79`.

Reason: the previous segment grid found rent-safe edge-shaped groups, but the split was still too broad to explain why adequately sampled groups had thin median returns while undersampled groups had stronger returns. Liquidity size and reserve growth are visible before entry and can be replayed without touching live funds.

Fresh current-window audit and replay:

- Rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T06-19-53-021Z.json`
- Events file: `data/meta-observer/events-2026-06-08T03-29-38-002Z.jsonl`
- First-buyer pools in window: `159`
- Transactions found: `159`
- With pool extension: `17`
- Without pool extension: `142`
- Replay grid before liquidity segmentation refresh: `data/meta-observer/replay-path-grid-study-2026-06-08T06-21-09-876Z.json`
- Liquidity segment replay grid: `data/meta-observer/replay-path-grid-study-2026-06-08T06-26-14-029Z.json`
- Paper profile candidates: `0`
- Paper segment candidates: `0`

Fresh current-window liquidity segment result:

- Broad `low_buy_competition`: `77` pools, `72` completed paths, rent-tradable rate `89.61%`, best median modeled net `4.0845%`, blocked by rent rate and modeled-margin thresholds.
- `strict_zero`: `43` pools, `40` completed paths, best median modeled net `34.6999%`, but rent-tradable rate `0%`, blocked by no rent-free first-buyer evidence.
- Best small rent-safe liquidity segment: `profile=crowded|rent=yes|initial_liquidity=75_to_125_sol|entry_liquidity_growth=0_to_10_pct|entry_momentum=0_to_10_pct|pre_entry_buys=3_to_5|pre_entry_interactions=11_plus`
- Small segment result: `6` pools, `5` completed paths, rent-tradable rate `100%`, win rate `100%`, best median modeled net `24.8883%`
- Blocker: `sample_pools<20`

Combined audited-window liquidity replay:

- Grid: `data/meta-observer/replay-path-grid-study-2026-06-08T06-27-39-748Z.json`
- Events files: `events-2026-06-05T13-16-06-840Z.jsonl`, `events-2026-06-05T13-44-16-379Z.jsonl`, `events-2026-06-08T03-29-38-002Z.jsonl`
- Rent audits: `first-buyer-rent-audit-2026-06-05T14-37-06-737Z.json`, `first-buyer-rent-audit-2026-06-05T14-47-04-759Z.json`, `first-buyer-rent-audit-2026-06-08T06-19-53-021Z.json`
- Paper profile candidates: `0`
- Paper segment candidates: `0`
- Broad `low_buy_competition`: `110` pools, `105` completed paths, rent-tradable rate `90.91%`, best median modeled net `5.0402%`, blocked by `median_modeled_net_return_pct<=15`.
- Best 20-plus-pool rent-safe liquidity segment: `22` pools, rent-tradable rate `100%`, best median modeled net `-0.4795%`, win rate `40.91%`, blocked by modeled-margin and win-rate thresholds.
- Best small rent-safe liquidity segment: `profile=low_buy_competition|rent=yes|initial_liquidity=75_to_125_sol|entry_liquidity_growth=0_to_10_pct|entry_momentum=0_to_10_pct|pre_entry_buys=1|pre_entry_interactions=6_to_10`
- Small segment result: `8` pools, `8` completed paths, rent-tradable rate `100%`, win rate `100%`, best median modeled net `16.9084%`
- Blocker: `sample_pools<20`

Interpretation: liquidity segmentation improved the search target but still did not justify live spending. The best adequately sampled rent-safe liquidity segment is negative. The best positive segment has the right shape but only `8` historical/audited pools. Live remains locked. The next valid work is to keep the observer/audit loop collecting until this exact segment either reaches `20` pools and still clears the strict gate, or decays and gets killed. No funded canary should run from this evidence.

### Replay Target Watch Gate

Code change:

- Commit: `8063f17 Add replay target watch gate`
- Added `npm run analyze:pumpswap:replay-target`.
- The command reads replay grid artifacts and tracks a configured target segment against deterministic thresholds.
- Default target segment:
  - `profile=low_buy_competition`
  - `rent=yes`
  - `initial_liquidity=75_to_125_sol`
  - `entry_liquidity_growth=0_to_10_pct`
  - `entry_momentum=0_to_10_pct`
  - `pre_entry_buys=1`
  - `pre_entry_interactions=6_to_10`
- Tests: local `npm test` passed `82/82`.

Server target-watch run:

- Artifact: `data/meta-observer/replay-target-watch-2026-06-08T06-32-21-855Z.json`
- Input grid: `data/meta-observer/replay-path-grid-study-2026-06-08T06-27-39-748Z.json`
- Status: `WAIT`
- Matching rows: `120`
- Candidate rows: `0`
- Best match: `8` pools, `8` completed paths, `100%` win rate, `16.91%` median modeled net
- Blockers: `sample_pools<20`, `completed_paths<20`

Interpretation: the target-watch gate makes the current decision explicit and repeatable. This target is not dead, but it is not spendable. It needs at least `20` completed audited replay paths while keeping rent tradability, win rate, median modeled net, and average modeled net above the strict thresholds. Until that happens, live remains locked.

### Replay Gate Refresh Command

Code change:

- Commit: `acaf66f Add replay gate refresh command`
- Added `npm run analyze:pumpswap:replay-gate-refresh`.
- The command runs the offline sequence:
  - first-buyer rent audit
  - strict replay grid
  - target-watch gate
  - summary artifact
- This command is non-trading. It reads observer/RPC data and writes artifacts; it does not open, close, or promote a wallet position.
- Tests: local `npm test` passed `82/82`.

First server refresh run:

- Summary artifact: `data/meta-observer/replay-gate-refresh-2026-06-08T06-38-07-100Z.json`
- Rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T06-36-08-905Z.json`
- Replay grid: `data/meta-observer/replay-path-grid-study-2026-06-08T06-38-06-250Z.json`
- Target watch: `data/meta-observer/replay-target-watch-2026-06-08T06-38-07-058Z.json`
- First-buyer pools: `168`
- Transactions found: `168`
- Without pool extension: `150`
- Target status: `WAIT`
- Target matching rows: `48`
- Candidate rows: `0`
- Best target match: `3` pools, `3` completed paths, `100%` win rate, `16.03%` median modeled net
- Blockers: `sample_pools<20`, `completed_paths<20`

Interpretation: the current-window target still has the right edge shape but not enough sample. The target decayed from the combined historical `8` completed paths to `3` completed paths in the fresh current-window-only refresh, so the right action is continued offline collection and refresh, not funded execution.

### Replay Gate Monitor

Code change:

- Added `npm run monitor:pumpswap:replay-gate`.
- Added PM2 app `darwin-replay-gate-monitor`.
- The monitor watches the active observer `events-*.jsonl` file and reruns the offline replay-gate refresh only after the file grows by the configured threshold.
- Defaults: `600000 ms` interval, `25000000` byte growth threshold, and `PUMPSWAP_REPLAY_GATE_MONITOR_RUN_ON_START=false`.
- Tests: local `npm test` passed `88/88`.

Interpretation: this converts the current target from a manual check into an offline evidence loop. It does not trade, promote, or unlock capital. Its only job is to keep asking whether the target segment has reached enough audited samples to become a paper candidate or has decayed enough to kill.

Server start:

- PM2 app `darwin-replay-gate-monitor` is online.
- State file: `data/meta-observer/replay-gate-refresh-monitor-state.json`
- Initial decision: `no_state_record_baseline`
- Latest target status at startup: `WAIT`
- Live trading remains locked.

### Promotion Batch Replay-Target Preflight

Code change:

- The 20-loop cyborg promotion batch now refuses to start unless the latest replay target-watch artifact is a clean `PAPER_CANDIDATE`.
- Missing target-watch artifacts, `WAIT`, `TARGET_NOT_FOUND`, zero candidate rows, or target blockers stop the batch before wallet resolution or any live buy.
- `CYBORG_PROMOTION_ALLOW_REPLAY_TARGET_BYPASS=true` exists only for one-off diagnostics and cannot count as Promotion Gate proof.
- Tests: local `npm test` passed `92/92`.

Current measured state:

- Monitor baseline event size: `663504101` bytes.
- Current event size checked manually: `672453287` bytes.
- Growth: `8949186` bytes, below the `25000000` byte refresh threshold.
- Latest target status remains `WAIT`.

Interpretation: the live 20-loop path is now mechanically attached to the offline replay gate. This does not make Darwin profitable yet, but it prevents the operator loop from spending tiny live canaries while the target is still under-sampled.

### Replay Gate Refresh 07:00

Server monitor refresh:

- Summary artifact: `data/meta-observer/replay-gate-refresh-2026-06-08T07-00-07-916Z.json`
- Rent audit: `data/meta-observer/first-buyer-rent-audit-2026-06-08T06-58-15-620Z.json`
- Replay grid: `data/meta-observer/replay-path-grid-study-2026-06-08T07-00-06-817Z.json`
- Target watch: `data/meta-observer/replay-target-watch-2026-06-08T07-00-07-845Z.json`
- First-buyer pools: `181`
- Transactions found: `181`
- Without pool extension: `162`
- Target status: `WAIT`
- Target matching rows: `48`
- Candidate rows: `0`
- Best target match: `3` pools, `3` completed paths, `100%` win rate, `16.03%` median modeled net
- Blockers: `sample_pools<20`, `completed_paths<20`

Code fix:

- Monitor state now excludes `replay-gate-refresh-monitor-state.json` when selecting the latest refresh artifact.
- Tests: local `npm test` passed `93/93`.

Interpretation: the fresh offline refresh did not promote the target. Live remains locked. The current blocker is still sample depth, not model edge on the tiny target.

### Replay Frontier and Target Mutation

Code change:

- Added `npm run analyze:pumpswap:replay-frontier`.
- The replay frontier classifies replay rows as `PAPER_CANDIDATE`, `COLLECT_MORE`, `MUTATE_EDGE`, `REJECT_RENT`, or `REJECT_SAMPLE_AND_EDGE`.
- The offline replay-gate refresh now runs the frontier step between replay grid and target-watch.
- Frontier `COLLECT_MORE` ranking is sample-first, so one-pool moonshots do not outrank deeper edge-shaped targets.
- Tests: local `npm test` passed `96/96`.

Server frontier run:

- Frontier artifact: `data/meta-observer/replay-frontier-2026-06-08T07-08-34-150Z.json`
- Input grid: `data/meta-observer/replay-path-grid-study-2026-06-08T07-00-06-817Z.json`
- Paper candidates: `0`
- Collect-more rows: `704`
- Mutate-edge rows: `0`
- Reject-rent rows: `8112`
- Best collect-more segment: `profile=crowded|rent=yes|initial_liquidity=75_to_125_sol|entry_liquidity_growth=0_to_10_pct|entry_momentum=0_to_10_pct|pre_entry_buys=3_to_5|pre_entry_interactions=11_plus`
- Best collect-more result: `6` pools, `5` completed paths, `100%` win rate, `24.8883%` median modeled net, `26.4006%` average modeled net
- Blockers: `sample_pools<20`, `completed_paths<20`
- Best scenario: `entryDelayMs=3000`, `exitAfterLaterBuys=10`, `maxHoldMs=15000`

Target mutation:

- Default replay target-watch segment was updated from the stale `low_buy_competition` 3-path target to the frontier-selected crowded rent-safe segment above.
- New target-watch artifact: `data/meta-observer/replay-target-watch-2026-06-08T07-09-33-885Z.json`
- Target status: `WAIT`
- Candidate rows: `0`
- Best target match: `6` pools, `5` completed paths, `100%` win rate, `24.89%` median modeled net
- Blockers: `sample_pools<20`, `completed_paths<20`
- Promotion batch preflight was tested against this latest artifact and correctly refused to start before any wallet action.

Interpretation: Darwin found a better frontier target, but it is still not spendable. The required next evidence is at least `20` completed audited paths on this crowded rent-safe segment while preserving the strict win/rent/edge thresholds.

Monitor state correction:

- Commit `0f193c6` updates `darwin-replay-gate-monitor` state reporting so `latestTargetArtifact` and `latestFrontierArtifact` point at the newest target/frontier artifacts, even when they were generated manually after the last full refresh.
- Server monitor state now points at `replay-target-watch-2026-06-08T07-09-33-885Z.json` and `replay-frontier-2026-06-08T07-08-34-150Z.json`.
- Latest monitor state remains `WAIT`; event growth since the current baseline was below the `25000000` byte refresh threshold.
- Tests: local `npm test` passed `96/96`.

### Replay Target to Live Config Bridge

Code change:

- Replay-target preflight now emits `recommendedEnv` from the `bestMatch` segment and scenario.
- The cyborg promotion batch applies those target-derived env keys before starting any live canary loop.
- The live scorer now supports `PUMPSWAP_CYBORG_SCORER_MIN_INTERACTIONS_5S`, so the crowded target can require `pre_entry_interactions=11_plus` instead of using the old low-noise scorer.
- Tests: local `npm test` passed `97/97`.

Current target-derived config for the frontier segment:

- Segment: `profile=crowded|rent=yes|initial_liquidity=75_to_125_sol|entry_liquidity_growth=0_to_10_pct|entry_momentum=0_to_10_pct|pre_entry_buys=3_to_5|pre_entry_interactions=11_plus`
- Scenario: `entryDelayMs=3000`, `exitAfterLaterBuys=10`, `maxHoldMs=15000`
- Scorer bridge: `minScore=18`, `minBuyCompetitors5s=3`, `maxBuyCompetitors5s=5`, `minInteractingWallets5s=11`, `maxInteractingWallets5s=999`, `minLiquiditySol=75`

Interpretation: this fixes a live-readiness mismatch. If the target eventually reaches `PAPER_CANDIDATE`, the promotion batch will run the crowded rent-safe segment that replay proved, not the stale quiet-pool default. This does not unlock live yet: the latest target remains `WAIT` with `6` pools, `5` completed paths, and blockers `sample_pools<20` plus `completed_paths<20`.

### Crowded Target Paper Candidate and Shadow Stop

Server target-watch:

- Artifact: `data/meta-observer/replay-target-watch-2026-06-08T16-06-33-467Z.json`
- Status: `PAPER_CANDIDATE`
- Candidate rows: `8`
- Segment: `profile=crowded|rent=yes|initial_liquidity=75_to_125_sol|entry_liquidity_growth=0_to_10_pct|entry_momentum=0_to_10_pct|pre_entry_buys=3_to_5|pre_entry_interactions=11_plus`
- Best match: `30` completed paths, `100%` rent-tradable rate, `70%` win rate, `17.8901%` median modeled net, `29.6588%` average modeled net
- Scenario: `entryDelayMs=5000`, `exitAfterLaterBuys=9`, `maxHoldMs=15000`

Target-config dry-run preflight:

- Artifact: `data/meta-observer/cyborg-dry-run-2026-06-08T16-13-22-656Z.json`
- Pool: `2bGhDEFkayoTrfd6LQAb5pKkUt7sLyfrtkTcPaMKKjfY`
- Profile: `crowded`
- Shape score: `18`
- Exit reason: `later_buy_threshold`
- Exit wait: `6542 ms`
- Modeled gross return: `13.6815%`
- Modeled net return: `-2.2845%`

Code change:

- Matching `cyborg-dry-run-*.json` shadow evidence is now included in `CyborgProfitabilityPreflight`.
- A modeled-negative dry-run for the same strategy config and canary size blocks the promotion batch before live spending.

Interpretation: the offline replay target is closer than before, but the first matching live-shadow target sample was modeled-negative after the fixed-cost proxy. This is not close enough for funded live proof. Live remains locked until a mutated target/config produces clean positive shadow evidence and then separately passes the 20-loop live Promotion Gate.

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
