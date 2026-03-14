#!/usr/bin/env python3
"""
eval.py — thin compatibility wrapper around the shared TypeScript evaluator.
Usage: python3 eval.py <since_timestamp_ms>
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


DARWIN_DIR = Path(__file__).resolve().parent


def run_eval(since_ts_ms: int) -> int:
    dist_cli = DARWIN_DIR / "dist" / "cli" / "eval-window.js"
    if dist_cli.exists():
        cmd = ["node", str(dist_cli), str(since_ts_ms)]
    else:
        cmd = ["npx", "ts-node", "src/cli/eval-window.ts", str(since_ts_ms)]

    result = subprocess.run(cmd, cwd=DARWIN_DIR, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr or result.stdout)
        return result.returncode

    sys.stdout.write(result.stdout)
    return 0


if __name__ == "__main__":
    since_ts = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    raise SystemExit(run_eval(since_ts))
