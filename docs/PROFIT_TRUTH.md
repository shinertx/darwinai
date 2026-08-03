# Darwin Profit Truth

This ledger separates wallet assets, modeled results, recoverable rent, and realized trading PnL. Update it only from transaction receipts, wallet deltas, and current read-only balance checks.

## 2026-08-02 Audit

Proof state: `REALIZED_TRADING_PNL_NOT_PROVEN`

Wallet: `4NHGyqw3vcbzajvzprwS8HVVDpTTCVw82isCq9jMGnuV`

Current liquid assets observed on-chain:

- `0.090540445 SOL`
- `0.907976 USDC`; a read-only Jupiter quote returned `0.012406762 SOL`
- one empty SPL token account contains `0.00203928 SOL` of recoverable rent

The USDC quote is not a sale. Recoverable rent is existing capital, not revenue. Twenty-two other nonzero token holdings returned no Jupiter route; unroutable does not prove permanently worthless.

Verified known execution losses:

| Evidence | Result |
| --- | ---: |
| `cyborg-canary-2026-06-05T14-06-20-077Z.json` | `-0.0070194 SOL` and not flattened |
| `cyborg-canary-2026-06-05T14-18-27-556Z.json` | `-0.00241144 SOL` and flattened |
| Twenty finalized zero-lamport self-transfers on 2026-07-17 | `-0.000100174 SOL` in fees |
| Total verified known loss | `-0.009531014 SOL` |

The July transactions invoked only the System Program, transferred zero lamports from the wallet to itself, changed no token balances, and therefore produced no revenue.

Historical stable-paper output showing `1,623+ SOL` is invalid evidence. It contains trades capped at `+10,000%` and entry-to-exit price ratios as high as `772x` within seconds. Research-paper output of `0.098080059 SOL` over 80 trades is modeled only and failed micro-live acceptance with approximately `37.54%` drawdown.

No positive, finalized, flattened Darwin round trip has been proven. Do not spend on another live canary until one frozen configuration has positive execution-aware replay evidence and a matching positive live-shadow sample.
