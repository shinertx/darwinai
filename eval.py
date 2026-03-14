#!/usr/bin/env python3
"""
eval.py — Darwin experiment evaluator
Usage: python3 eval.py <since_timestamp_ms>
Outputs JSON with composite score (higher = better)
"""
import sqlite3, json, sys, os

DB_PATH = os.path.join(os.path.dirname(__file__), 'darwin.db')

def compute_score(since_ts_ms):
    conn = sqlite3.connect(DB_PATH)
    trades = conn.execute("""
        SELECT pnl_sol, pnl_pct, exit_reason, hold_ms, signal_type, closed_at
        FROM trades
        WHERE closed_at > ? AND is_paper = 1
        ORDER BY closed_at ASC
    """, (since_ts_ms,)).fetchall()
    conn.close()

    if len(trades) < 10:
        return {
            "score": -99.0,
            "trades": len(trades),
            "reason": f"insufficient_trades (need 10, got {len(trades)})",
            "win_rate": 0, "profit_factor": 0,
            "avg_loss_pct": 0, "total_pnl_sol": 0,
            "avg_winner_pct": 0,
            "best_trade_pct": 0,
            "max_drawdown_sol": 0,
            "gross_wins_sol": 0,
            "gross_losses_sol": 0,
            "no_pump_bail_pct": 0,
            "no_pump_bail_count": 0,
            "migration_pct": 0,
            "migration_trades": 0,
            "migration_winners": 0,
            "migration_win_rate": 0,
            "winners": 0,
            "losers": 0,
        }

    winners = [t for t in trades if t[0] > 0]
    losers  = [t for t in trades if t[0] <= 0]

    win_rate      = len(winners) / len(trades)
    gross_wins    = sum(t[0] for t in winners)
    gross_losses  = abs(sum(t[0] for t in losers))
    profit_factor = min(gross_wins / gross_losses, 5.0) if gross_losses > 0 else 2.0
    avg_loss_pct  = (sum(t[1] for t in losers) / len(losers) * 100) if losers else 0
    avg_winner_pct = (sum(t[1] for t in winners) / len(winners) * 100) if winners else 0
    best_trade_pct = max((t[1] for t in trades), default=0) * 100

    no_pump_count = sum(1 for t in trades if t[2] == 'no_pump_bail')
    no_pump_pct   = no_pump_count / len(trades)
    total_pnl     = sum(t[0] for t in trades)
    running_pnl = 0.0
    peak_pnl = 0.0
    max_drawdown_sol = 0.0

    for trade in trades:
        running_pnl += trade[0]
        peak_pnl = max(peak_pnl, running_pnl)
        max_drawdown_sol = max(max_drawdown_sol, peak_pnl - running_pnl)

    # Composite — higher is better
    score = (
        profit_factor * 0.40 +
        win_rate      * 0.40 -
        abs(avg_loss_pct) * 0.01   # avg loss in % penalised lightly
    )

    # Heavy penalty if >85% of trades are noise bailouts
    if no_pump_pct > 0.85:
        score -= (no_pump_pct - 0.85) * 3.0

    # Win rate floor — below 8% is disqualifying
    if win_rate < 0.08:
        score -= (0.08 - win_rate) * 5.0

    # Migration-specific stats
    migration = [t for t in trades if len(t) > 4 and t[4] == "migration"]
    mig_wins  = [t for t in migration if t[0] > 0]
    mig_winners = len(mig_wins)
    mig_win_rate = round(len(mig_wins)/len(migration)*100,1) if migration else 0

    return {
        "score":            round(score, 4),
        "trades":           len(trades),
        "win_rate":         round(win_rate * 100, 1),
        "profit_factor":    round(profit_factor, 3),
        "avg_loss_pct":     round(avg_loss_pct, 2),
        "avg_winner_pct":   round(avg_winner_pct, 2),
        "best_trade_pct":   round(best_trade_pct, 2),
        "max_drawdown_sol": round(max_drawdown_sol, 6),
        "total_pnl_sol":    round(total_pnl, 6),
        "gross_wins_sol":   round(gross_wins, 6),
        "gross_losses_sol": round(gross_losses, 6),
        "no_pump_bail_pct": round(no_pump_pct * 100, 1),
        "no_pump_bail_count": no_pump_count,
        "winners":          len(winners),
        "losers":           len(losers),
        "migration_trades": len(migration),
        "migration_winners": mig_winners,
        "migration_win_rate": mig_win_rate,
    }

if __name__ == "__main__":
    since_ts = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    result = compute_score(since_ts)
    print(json.dumps(result, indent=2))
