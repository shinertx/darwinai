# Strategy Quarantine

Strategies listed here are not eligible for live promotion or capital scaling.

## cyborg-lowcomp-min58-pool-extend

Status: `QUARANTINED`

Reason: On 2026-06-05, this strategy allowed `DARWIN_LIVE_ALLOW_POOL_EXTEND=true` during a tiny `0.0001 SOL` canary. It produced a confirmed buy, failed the autonomous sell, left an unflattened token position, and recorded `-0.007019400 SOL` net wallet delta before manual cleanup.

Evidence:

- Result: `data/meta-observer/cyborg-canary-2026-06-05T14-06-20-077Z.json`
- Gate record: `data/promotion-gate/promotion-gate-fail-2026-06-05T14-09-10-453Z.json`
- Manual cleanup: `data/live-canary/close-canary-2026-06-05T14-08-31-830Z.json`

Rule: Do not run pool-extension as a promotion strategy. A one-off diagnostic may use `CYBORG_PROMOTION_ALLOW_QUARANTINED_POOL_EXTEND=true`, but that path cannot count toward Promotion Gate success.
