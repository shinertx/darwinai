# Promotion Gate v1

Promotion Gate v1 is the deterministic control plane for Darwin live size increases.

The gate answers one question: did a single frozen strategy/config prove enough real, reconciled, net-positive live round trips to earn more capital?

## Required Inputs

Each promotion request must include:

- `strategyId`: the Darwin strategy responsible for the request.
- `strategyHash`: a frozen fingerprint of the strategy/config/code context.
- `wallet`: the public key used for all live loops.
- `startedAtMs` and `endedAtMs`: the operating window.
- `loops`: one record per completed round trip.

Each loop must include:

- `buySignature`
- `sellSignature`
- `mint`
- `pool`
- `buyWalletDeltaSol`
- `sellWalletDeltaSol`
- `tokenDeltaRaw`
- `afterTokenAmountRaw`
- `manualRescue`

## Pass Conditions

Promotion Gate v1 emits `PASS` only when all conditions are true:

- At least 20 loops are present.
- All loops belong to one `strategyId` and one `strategyHash`.
- The evidence window is at most 24 hours.
- Every buy and sell signature is present and finalized on-chain.
- Every loop has numeric wallet deltas.
- Every loop is flattened: `afterTokenAmountRaw === "0"`.
- Every loop has sold/reduced the token balance: `tokenDeltaRaw < 0`.
- No loop is marked `manualRescue`.
- Aggregate net wallet delta is positive.
- No uncontrolled process restart evidence is present.
- No open test positions are declared.

Any failed condition emits `FAIL`. A failed gate is not a partial promotion.

## Command

Build promotion evidence from autonomous cyborg canary result files:

```bash
CYBORG_PROMOTION_INPUT_DIR=data/meta-observer \
PROMOTION_GATE_MIN_LOOPS=20 \
PROMOTION_FAILED_ATTEMPT_WALLET_DELTA_SOL=0 \
PROMOTION_OPEN_TEST_POSITIONS= \
npm run promotion:evidence:cyborg
```

Then run the gate from the generated evidence file:

```bash
PROMOTION_GATE_INPUT=data/promotion-gate/evidence.json \
PROMOTION_GATE_VERIFY_ONCHAIN=true \
npm run promotion:gate
```

The command writes a durable record under `data/promotion-gate/`. A `FAIL` exits non-zero and must block size increases.

Cyborg canary result files include the scorer threshold, alert window, execution defer window, live signal max age, live state-rent permissions, close-on-sell setting, and execution route. The evidence builder includes that config in `strategyHash` and rejects selected loops with mixed configs.

To run the full foreground batch loop, after the non-trading PumpSwap meta observer is collecting `events-*.jsonl`:

```bash
CYBORG_PROMOTION_TARGET_LOOPS=20 \
CYBORG_PROMOTION_MAX_ATTEMPTS=100 \
PUMPSWAP_CYBORG_CANARY_SIZE_SOL=0.0001 \
PUMPSWAP_CYBORG_CANARY_TIMEOUT_MS=1200000 \
PUMPSWAP_CYBORG_EXECUTION_DEFER_MS=10000 \
PUMPSWAP_CYBORG_EXIT_AFTER_LATER_BUYS=10 \
PUMPSWAP_CYBORG_MAX_HOLD_MS=60000 \
DARWIN_LIVE_SIGNAL_MAX_AGE_MS=90000 \
CYBORG_PROMOTION_STOP_ON_NON_POSITIVE_LOOP=true \
DARWIN_LIVE_CLOSE_TOKEN_ATA_ON_SELL=true \
npm run promotion:batch:cyborg
```

This runs sequential one-loop canaries in the foreground, waits for the replay-backed exit rule (`10` later non-creator buy wallets or `60000 ms` max hold), stops on any unflattened position, builds promotion evidence for only that batch window, then runs Promotion Gate v1. It does not start `darwin-live` or increase trade size.

`CYBORG_PROMOTION_STOP_ON_NON_POSITIVE_LOOP=true` stops the batch after the first completed loop that is not net-positive, then writes fail evidence instead of spending through more losing loops.

Before spending the first loop, the batch runner also scans recent `cyborg-canary-*.json` evidence for the same cyborg strategy config and canary size. If that exact config and size already produced a non-positive, incomplete, or unflattened live loop, the runner refuses to start. `CYBORG_PROMOTION_ALLOW_KNOWN_UNPROFITABLE=true` is a diagnostic override only; it must not be used as promotion proof.

Before spending the first loop, the batch runner must also find a latest `replay-target-watch-*.json` artifact whose status is `PAPER_CANDIDATE`, with at least one candidate row and no target blockers. `WAIT`, `TARGET_NOT_FOUND`, missing artifacts, or blocked best matches keep live locked. `CYBORG_PROMOTION_ALLOW_REPLAY_TARGET_BYPASS=true` is a diagnostic override only; it must not be used as promotion proof.

When a config is blocked by known live loss evidence, run the offline break-even analyzer before proposing another live canary:

```bash
CYBORG_BREAKEVEN_SIZE_SOL=0.0001 \
CYBORG_BREAKEVEN_EXPECTED_EDGE_PCT_LIST=1,5,10,25,50,100 \
npm run analyze:cyborg:breakeven
```

The report writes to `data/promotion-gate/cyborg-break-even-*.json` and converts wallet-delta loss evidence into the gross edge required to break even at the current canary size. If the required gross edge is unrealistic, the next work is cohort/strategy rewrite in paper or historical analysis, not another live attempt.

Pool-extension promotion is quarantined. On 2026-06-05, `cyborg-lowcomp-min58-pool-extend` produced a confirmed buy, failed autonomous sell, unflattened token position, and `-0.007019400 SOL` net wallet delta. Promotion batches now refuse `DARWIN_LIVE_ALLOW_POOL_EXTEND=true` unless `CYBORG_PROMOTION_ALLOW_QUARANTINED_POOL_EXTEND=true` is set for a one-off diagnostic. That diagnostic path must not be treated as promotion-ready capital proof.

## Capital Rule

No code path, agent, or operator may increase live trade size from a strategy unless the latest promotion record for that same `strategyId` and `strategyHash` is `PASS`.

The first allowed ladder after a `PASS` should remain tiny, for example:

```text
0.0001 -> 0.00025 -> 0.0005 -> 0.001 SOL
```

Larger jumps require a later gate version.

## Failure Feedback

A `FAIL` record should be fed back into Darwin's Software 3.0 loop as context for mutation:

- failed signature verification means fix logging or RPC reconciliation
- negative net SOL means rewrite strategy/exit logic
- unclosed positions mean fix exit automation
- known-unprofitable preflight failure means do not spend another identical tiny canary; rewrite the strategy/search loop or prove a new config offline first
- restart evidence means fix process controls
- manual rescue means the strategy did not autonomously prove itself
