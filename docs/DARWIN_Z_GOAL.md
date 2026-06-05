# Darwin Z Goal

Darwin's final goal is to become a Software 3.0 Solana trading organism that earns capital increases through deterministic proof, not vibes or manual override.

## 24-Hour Money Gate

Within a 24-hour operating window, Darwin must prove it can produce real, repeatable, net-positive SOL through fully verified live round trips, or live trading stays locked.

Success requires all of the following:

- At least 20 complete tiny live loops.
- Each loop has a finalized on-chain buy and finalized on-chain sell.
- Each loop reconciles to wallet SOL delta, not internal logs.
- Net wallet SOL is positive after fees, slippage, rent, failed attempts, and closed positions.
- No uncontrolled live process restarts.
- No manual rescue trades counted as wins.
- No open test positions left unresolved.
- One strategy/config is clearly responsible for the positive result.
- Promotion Gate v1 writes an explicit `PASS` record before any size increase.

Failure means:

- Darwin stays paper-only.
- No capital scaling.
- Losing or unverifiable strategies are killed or quarantined.
- The next work is rewriting the strategy/search loop from the failure evidence.

## Operating Meaning

Darwin is not trying to win one lucky trade. It is trying to prove that an evolving strategy can repeatedly survive real Solana execution conditions and return more SOL to the wallet than it spent.

The codebase, prompts, strategy context, execution settings, canary evidence, and promotion records together form the Software 3.0 organism. The deterministic outer gate controls capital. The AI inner loop can propose, mutate, explain, and rewrite, but it cannot grant itself larger live size.
