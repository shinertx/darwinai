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
- restart evidence means fix process controls
- manual rescue means the strategy did not autonomously prove itself
