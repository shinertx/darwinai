#!/usr/bin/env python3
"""
meta_agent.py — Darwin paper-only autoresearch loop

Each cycle:
  1. Pick one approved tunable runtime file
  2. Ask OpenAI for one targeted improvement
  3. Build and restart the paper app only
  4. Wait for fresh paper trades
  5. Keep or revert using the shared mission evaluator
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from swarm_coordinator import ClaimRecord, GitHubSwarmCoordinator


def load_env_file(path: Path, override: bool = False) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if override or key not in os.environ:
            os.environ[key] = value


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


DARWIN_DIR = Path(__file__).resolve().parent
load_env_file(DARWIN_DIR / ".env")
load_env_file(DARWIN_DIR / ".env.local", override=True)

LOG_PATH = DARWIN_DIR / "autoresearch.log"
HISTORY_PATH = DARWIN_DIR / "autoresearch_history.json"
PROGRAM_PATH = DARWIN_DIR / "program.md"
TYPES_PATH = DARWIN_DIR / "src/types.ts"

TARGET_APP = os.getenv("AUTORESEARCH_TARGET_APP", "darwin-paper-research").strip() or "darwin-paper-research"
TARGET_APP_OUT_LOG = Path.home() / ".pm2" / "logs" / f"{TARGET_APP}-out.log"
TARGET_APP_ERR_LOG = Path.home() / ".pm2" / "logs" / f"{TARGET_APP}-error.log"

EXPERIMENT_MIN = int(os.getenv("AUTORESEARCH_EXPERIMENT_MINUTES", "8"))
MIN_TRADES = int(os.getenv("AUTORESEARCH_MIN_TRADES", "30"))
MAX_EXPERIMENTS = int(os.getenv("AUTORESEARCH_MAX_EXPERIMENTS", "200"))
VALIDATION_WINDOWS = max(1, int(os.getenv("AUTORESEARCH_VALIDATION_WINDOWS", "2")))
MAX_EVAL_WAIT_CYCLES = max(1, int(os.getenv("AUTORESEARCH_MAX_WAIT_CYCLES", "4")))
EVAL_WAIT_MINUTES = max(1, int(os.getenv("AUTORESEARCH_WAIT_MINUTES", "10")))
MODEL = os.getenv("OPENAI_MODEL", "gpt-5.3-codex")
REASONING_EFFORT = os.getenv("OPENAI_REASONING_EFFORT", "medium").strip().lower()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
MIRROR_DIR = os.getenv("AUTORESEARCH_MIRROR_DIR", "").strip()
PUSH_AFTER_KEEP = env_flag("AUTORESEARCH_PUSH_AFTER_KEEP", default=False)
SWARM_ENABLED = env_flag("AUTORESEARCH_ENABLE_SWARM", default=False)

TUNABLE_FILES = [
    "src/evolution/EvolutionEngine.ts",
    "src/genome/GenomeFactory.ts",
    "src/market/MarketFeed.ts",
    "src/Orchestrator.ts",
    "src/execution/BankrollManager.ts",
]

TIER_PRIORITY = {
    "hard_fail": 0,
    "tier_c": 1,
    "tier_b": 2,
    "tier_a": 3,
}


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("autoresearch")
swarm: GitHubSwarmCoordinator | None = None


def run(cmd: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        cmd,
        shell=True,
        cwd=DARWIN_DIR,
        capture_output=True,
        text=True,
        env=merged_env,
    )


def shell_quote(value: str) -> str:
    return shlex.quote(value)


def sleep_with_heartbeat(total_seconds: float, claim: ClaimRecord | None = None) -> None:
    deadline = time.time() + max(0.0, total_seconds)
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            return
        time.sleep(min(5.0, remaining))
        if swarm is not None:
            swarm.heartbeat(claim)


def extract_response_text(payload: dict) -> str:
    if isinstance(payload.get("output_text"), str) and payload["output_text"].strip():
        return payload["output_text"].strip()

    texts: list[str] = []
    for item in payload.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                texts.append(content["text"])
    return "\n".join(texts).strip()


def ask_openai(prompt: str, max_output_tokens: int = 4096) -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set")

    body: dict[str, object] = {
        "model": MODEL,
        "input": prompt,
        "max_output_tokens": max_output_tokens,
        "store": False,
    }
    if REASONING_EFFORT:
        body["reasoning"] = {"effort": REASONING_EFFORT}

    request = urllib.request.Request(
        f"{OPENAI_BASE_URL}/responses",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API error {exc.code}: {body[:600]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenAI request failed: {exc.reason}") from exc

    text = extract_response_text(payload)
    if not text:
        raise RuntimeError("OpenAI response did not include output text")
    return text


def read_file(rel_path: str) -> str:
    return (DARWIN_DIR / rel_path).read_text()


def write_file(rel_path: str, content: str) -> None:
    (DARWIN_DIR / rel_path).write_text(content)


def extract_code(raw: str) -> str:
    if "---FILE---" in raw:
        return raw.split("---FILE---", 1)[1].strip()
    if "```" in raw:
        block = raw.split("```", 1)[1].split("```", 1)[0]
        lines = block.splitlines()
        if lines and lines[0].strip() in {"typescript", "ts"}:
            lines = lines[1:]
        return "\n".join(lines).strip()
    return raw.strip()


def load_history() -> list[dict]:
    if not HISTORY_PATH.exists():
        return []
    try:
        data = json.loads(HISTORY_PATH.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_history(history: list[dict]) -> None:
    HISTORY_PATH.write_text(json.dumps(history, indent=2))


def get_program_context() -> tuple[str, str]:
    return PROGRAM_PATH.read_text(), TYPES_PATH.read_text()


def build_prompt(file_path: str, current_code: str, baseline: dict, history: list[dict]) -> str:
    program_md, types_ts = get_program_context()
    history_str = json.dumps(history[-5:], indent=2) if history else "[]"
    baseline_str = json.dumps(baseline, indent=2)

    return f"""You are optimizing Darwin, a paper-first evolutionary Solana trading bot.

=== PROGRAM INSTRUCTIONS ===
{program_md}

=== AVAILABLE TYPES (src/types.ts) ===
{types_ts}

=== CURRENT BASELINE ASSESSMENT ===
{baseline_str}

=== LAST {min(5, len(history))} EXPERIMENTS ===
{history_str}

=== FILE TO MODIFY: {file_path} ===
{current_code}

=== YOUR TASK ===
State your hypothesis in 1-2 sentences, then return the COMPLETE modified file.

CRITICAL CONSTRAINTS:
- The file MUST compile with TypeScript (tsc) without errors
- Do NOT add any new import statements
- Do NOT change function signatures or method names that other files depend on
- Do NOT touch files outside the one shown above
- Do NOT modify evaluation logic, docs, or logging schema from this file
- Make exactly ONE targeted runtime change that should improve Darwin's mission alignment

Output format:
HYPOTHESIS: <your reasoning>
---FILE---
<complete file content>"""


def eval_window(since_ts_ms: int, claim: ClaimRecord | None = None) -> dict:
    def parse_assessment_output(result: subprocess.CompletedProcess[str]) -> dict:
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        failure_message = None

        if result.returncode != 0:
            failure_message = (
                f"eval command failed with exit {result.returncode} | "
                f"stdout={stdout[:400]} | stderr={stderr[:400]}"
            )

        def decode_payload(raw: str, label: str) -> dict | None:
            if not raw:
                return None
            payload = raw
            if not payload.startswith("{"):
                match = re.search(r"(\{.*\})", payload, re.DOTALL)
                if not match:
                    return None
                payload = match.group(1)
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                return None

        data = decode_payload(stdout, "stdout") or decode_payload(stderr, "stderr")
        if data is None:
            if failure_message:
                raise RuntimeError(failure_message)
            raise RuntimeError(f"eval returned no parseable JSON | stdout={stdout[:400]} | stderr={stderr[:400]}")

        metrics = data.get("metrics") if isinstance(data.get("metrics"), dict) else {}
        trade_count = data.get("trades", data.get("trade_count", metrics.get("tradeCount", 0)))
        data["_trade_count"] = int(trade_count or 0)
        return data

    for _ in range(MAX_EVAL_WAIT_CYCLES):
        result = run(f"python3 eval.py {since_ts_ms}")
        try:
            data = parse_assessment_output(result)
            if data["_trade_count"] >= MIN_TRADES:
                data.pop("_trade_count", None)
                return data
            log.info(
                "  Only %s paper trades so far, waiting %s more minutes...",
                data["_trade_count"],
                EVAL_WAIT_MINUTES,
            )
            sleep_with_heartbeat(EVAL_WAIT_MINUTES * 60, claim)
        except Exception as exc:
            log.error("  eval parse error: %s", exc)
            sleep_with_heartbeat(60, claim)

    result = run(f"python3 eval.py {since_ts_ms}")
    data = parse_assessment_output(result)
    data.pop("_trade_count", None)
    return data


def collect_window_metrics(label: str, claim: ClaimRecord | None = None) -> dict:
    window_start = int(time.time() * 1000)
    log.info("  [%s] Waiting %s minutes for fresh paper trades...", label, EXPERIMENT_MIN)
    sleep_with_heartbeat(EXPERIMENT_MIN * 60, claim)
    assessment = eval_window(window_start, claim)
    log.info("  [%s] Assessment: %s", label, summarize_assessment(assessment))
    return {"since_ts_ms": window_start, "assessment": assessment}


def rebuild() -> bool:
    log.info("  Building Darwin...")
    result = run("npm run build")
    if result.returncode != 0:
        log.error("  BUILD FAILED:\n%s", (result.stdout + result.stderr)[-1200:])
        return False
    return True


def wait_for_target_app_ready() -> bool:
    for _ in range(60):
        time.sleep(1)
        stdout = TARGET_APP_OUT_LOG.read_text() if TARGET_APP_OUT_LOG.exists() else ""
        stderr = TARGET_APP_ERR_LOG.read_text() if TARGET_APP_ERR_LOG.exists() else ""
        recent = "\n".join(stdout.splitlines()[-80:] + stderr.splitlines()[-40:])
        if "Mode: PAPER" in recent and "All systems running" in recent:
            return True
        if "Fatal error" in recent:
            return False
    return False


def restart_target_app() -> bool:
    result = run(f"pm2 restart {shell_quote(TARGET_APP)} --update-env")
    if result.returncode != 0:
        result = run(f"pm2 start ecosystem.config.cjs --only {shell_quote(TARGET_APP)} --update-env")
    if result.returncode != 0:
        log.error("  Failed to restart/start %s:\n%s", TARGET_APP, (result.stdout + result.stderr)[-800:])
        return False

    ready = wait_for_target_app_ready()
    log.info("  %s health: %s", TARGET_APP, "READY" if ready else "FAILED")
    return ready


def git_commit(file_path: str, message: str) -> bool:
    quoted = shell_quote(file_path)
    run(f"git add -- {quoted}")
    staged = run(f"git diff --cached --quiet -- {quoted}")
    if staged.returncode == 0:
        return False
    result = run(f"git commit -m {shell_quote(message)} -- {quoted}")
    if result.returncode != 0:
        log.error("  Commit failed:\n%s", (result.stdout + result.stderr)[-800:])
        return False
    return True


def mirror_kept_change(file_path: str, message: str) -> bool:
    if not MIRROR_DIR:
        return True

    mirror_dir = Path(MIRROR_DIR).expanduser()
    if not mirror_dir.exists():
        log.error("  Mirror dir does not exist: %s", mirror_dir)
        return False

    source_path = DARWIN_DIR / file_path
    target_path = mirror_dir / file_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(source_path.read_text())

    mirror_dir_quoted = shell_quote(str(mirror_dir))
    file_quoted = shell_quote(file_path)
    run(f"git -C {mirror_dir_quoted} add -- {file_quoted}")
    staged = run(f"git -C {mirror_dir_quoted} diff --cached --quiet -- {file_quoted}")
    if staged.returncode == 0:
        return True

    commit_result = run(f"git -C {mirror_dir_quoted} commit -m {shell_quote(message)} -- {file_quoted}")
    if commit_result.returncode != 0:
        log.error("  Mirror commit failed:\n%s", (commit_result.stdout + commit_result.stderr)[-800:])
        return False

    if PUSH_AFTER_KEEP:
        branch_result = run(f"git -C {mirror_dir_quoted} branch --show-current")
        branch = (branch_result.stdout or "").strip()
        if branch:
            push_result = run(f"git -C {mirror_dir_quoted} push origin {shell_quote(branch)}")
            if push_result.returncode != 0:
                log.error("  Mirror push failed:\n%s", (push_result.stdout + push_result.stderr)[-800:])
                return False

    return True


def file_is_dirty(file_path: str) -> bool:
    quoted = shell_quote(file_path)
    return (
        run(f"git diff --quiet -- {quoted}").returncode != 0
        or run(f"git diff --cached --quiet -- {quoted}").returncode != 0
    )


def revert_file(file_path: str, backup_code: str) -> bool:
    write_file(file_path, backup_code)
    if not rebuild():
        return False
    return restart_target_app()


def pick_file(experiment_num: int, baseline: dict) -> str:
    no_pump = float(baseline.get("no_pump_bail_pct", 50))
    migration_share = float(baseline.get("migration_share", 0))
    migration_win_rate = float(baseline.get("migration_win_rate", 0))
    fill_ratio = float(baseline.get("fill_ratio", 1))

    if fill_ratio < 0.65:
        return "src/execution/BankrollManager.ts"
    if no_pump > 55:
        return TUNABLE_FILES[(experiment_num - 1) % 3 + 2]
    if migration_share < 75 or migration_win_rate < 45:
        return TUNABLE_FILES[(experiment_num - 1) % 2]
    return TUNABLE_FILES[(experiment_num - 1) % len(TUNABLE_FILES)]


def build_fix_prompt(errors: str, error_context: str, hypothesis: str, file_path: str) -> str:
    return f"""The TypeScript code you wrote has build errors. Fix ONLY the specific errors.

BUILD ERRORS:
{errors[:1000]}
{error_context}

ORIGINAL HYPOTHESIS: {hypothesis}
FILE: {file_path}

RULES:
- Return the COMPLETE corrected file
- Fix ONLY the lines causing the build errors shown above
- Do not change logic outside the error locations
- No markdown fences, no explanation"""


def extract_error_context(file_path: str, errors: str) -> str:
    written_lines = read_file(file_path).splitlines()
    matches = re.findall(r"\((\d+),\d+\):", errors)
    snippets = []
    seen: set[int] = set()
    for line_str in matches[:4]:
        line_number = int(line_str)
        if line_number in seen:
            continue
        seen.add(line_number)
        start = max(0, line_number - 5)
        end = min(len(written_lines), line_number + 4)
        snippet = "\n".join(
            f"{index + 1:4d}| {written_lines[index]}"
            for index in range(start, end)
        )
        snippets.append(f"Line {line_number}:\n{snippet}")
    return "\n\nFAILING CODE CONTEXT:\n" + "\n\n".join(snippets) if snippets else ""


def summarize_assessment(assessment: dict) -> str:
    return (
        f"{assessment.get('tier', '?')} | "
        f"growth {float(assessment.get('bankroll_growth_pct', 0)):.2f}% | "
        f"best {float(assessment.get('best_trade_pct', 0)):.1f}% | "
        f"mig {float(assessment.get('migration_share', 0)):.1f}% @ "
        f"{float(assessment.get('migration_win_rate', 0)):.1f}% | "
        f"no_pump {float(assessment.get('no_pump_bail_pct', 0)):.1f}% | "
        f"dd {float(assessment.get('max_drawdown_pct', 0)):.1f}% | "
        f"fill {float(assessment.get('fill_ratio', 0)):.2f}"
    )


def compare_rank_keys(left: dict, right: dict) -> int:
    left_key = tuple(float(value) for value in left.get("rank_key", []))
    right_key = tuple(float(value) for value in right.get("rank_key", []))
    max_len = max(len(left_key), len(right_key))

    for index in range(max_len):
        left_value = left_key[index] if index < len(left_key) else 0.0
        right_value = right_key[index] if index < len(right_key) else 0.0
        if left_value == right_value:
            continue
        return 1 if left_value > right_value else -1
    return 0


def is_better_assessment(candidate: dict, baseline: dict) -> bool:
    candidate_tier = TIER_PRIORITY.get(candidate.get("tier", "hard_fail"), 0)
    baseline_tier = TIER_PRIORITY.get(baseline.get("tier", "hard_fail"), 0)
    if candidate_tier != baseline_tier:
        return candidate_tier > baseline_tier
    return compare_rank_keys(candidate, baseline) > 0


def worsened_too_much(candidate: dict, baseline: dict, key: str) -> bool:
    baseline_value = float(baseline.get(key, 0))
    candidate_value = float(candidate.get(key, 0))
    allowance = baseline_value * 1.05 if baseline_value > 0 else 5.0
    return candidate_value > allowance


def migration_regressed(candidate: dict, baseline: dict) -> bool:
    return float(candidate.get("migration_win_rate", 0)) + 1e-9 < float(baseline.get("migration_win_rate", 0))


def candidate_passes(baseline: dict, aggregate: dict, window_results: list[dict]) -> tuple[bool, str]:
    if aggregate.get("tier") == "hard_fail":
        return False, "aggregate_hard_fail"

    for window_index, window in enumerate(window_results, start=1):
        if window.get("tier") == "hard_fail":
            return False, f"window_{window_index}_hard_fail"

    if not is_better_assessment(aggregate, baseline):
        return False, "rank_tuple_not_improved"

    if migration_regressed(aggregate, baseline):
        return False, "migration_win_rate_regressed"

    if worsened_too_much(aggregate, baseline, "no_pump_bail_pct"):
        return False, "no_pump_bail_worsened_over_5pct_relative"

    if worsened_too_much(aggregate, baseline, "max_drawdown_pct"):
        return False, "max_drawdown_worsened_over_5pct_relative"

    return True, "mission_improved"


def failure_assessment(reason: str) -> dict:
    return {
        "tier": "hard_fail",
        "rank_key": [],
        "bankroll_growth_pct": -999.0,
        "migration_win_rate": 0.0,
        "no_pump_bail_pct": 100.0,
        "max_drawdown_pct": 100.0,
        "fill_ratio": 0.0,
        "gate_failures": [reason],
        "assessment_error": reason,
    }


def build_result_payload(
    *,
    experiment_id: str,
    file_path: str,
    hypothesis: str,
    baseline: dict,
    aggregate_result: dict,
    window_results: list[dict],
    kept: bool,
    reason: str,
    commit_sha: str,
    branch: str,
) -> dict:
    return {
        "experiment_id": experiment_id,
        "runner_id": os.getenv("AUTORESEARCH_RUNNER_ID", "").strip() or "unknown",
        "target_file": file_path,
        "hypothesis": hypothesis,
        "hypothesis_slug": normalize_hypothesis_slug(hypothesis),
        "baseline_rank_key": baseline.get("rank_key", []),
        "result_rank_key": aggregate_result.get("rank_key", []),
        "tier": aggregate_result.get("tier"),
        "keeper": kept,
        "reason": reason,
        "commit_sha": commit_sha,
        "branch": branch,
        "assessment": aggregate_result,
        "baseline_assessment": baseline,
        "validation_windows": window_results,
        "published_at": _utc_now_iso(),
    }


def normalize_hypothesis_slug(hypothesis: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", hypothesis.lower()).strip("-")
    return (slug or "no-hypothesis")[:80].rstrip("-") or "no-hypothesis"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_insight_payload(
    *,
    experiment_id: str,
    file_path: str,
    kept: bool,
    reason: str,
    aggregate_result: dict,
    baseline: dict,
) -> dict:
    body = (
        f"Experiment on `{file_path}` ended with `{aggregate_result.get('tier')}` and `{reason}`. "
        f"Baseline was {summarize_assessment(baseline)}. "
        f"Result was {summarize_assessment(aggregate_result)}. "
        f"{'The keeper improved the shared mission rank tuple and is a valid research promotion.' if kept else 'This result should not replace the current research best.'}"
    )
    return {
        "experiment_id": experiment_id,
        "slug": f"{normalize_hypothesis_slug(file_path)}-{reason}",
        "title": f"{'keeper' if kept else 'non-keeper'} {reason}",
        "target_file": file_path,
        "keeper": kept,
        "tier": aggregate_result.get("tier"),
        "body": body,
    }


def build_hypothesis_payload(
    *,
    experiment_id: str,
    file_path: str,
    kept: bool,
    reason: str,
    aggregate_result: dict,
    baseline: dict,
) -> dict:
    next_step = (
        "Push the same direction one step further while preserving the mission rank tuple."
        if kept
        else "Avoid repeating this exact change and target the next weakest mission metric instead."
    )
    focus = "migration_win_rate" if float(aggregate_result.get("migration_win_rate", 0)) < float(baseline.get("migration_win_rate", 0)) else "no_pump_bail_pct"
    return {
        "experiment_id": experiment_id,
        "slug": f"{normalize_hypothesis_slug(file_path)}-{focus}",
        "target_file": file_path,
        "keeper": kept,
        "priority": 3 if kept else 2,
        "reason": reason,
        "focus_metric": focus,
        "hypothesis": next_step,
        "baseline_rank_key": baseline.get("rank_key", []),
        "result_rank_key": aggregate_result.get("rank_key", []),
        "published_at": _utc_now_iso(),
    }


def main() -> int:
    global swarm

    if not OPENAI_API_KEY:
        log.error("OPENAI_API_KEY is required for autoresearch.")
        return 1

    swarm = GitHubSwarmCoordinator(
        darwin_dir=DARWIN_DIR,
        tunable_files=TUNABLE_FILES,
        logger=lambda message: log.info("  [swarm] %s", message),
        runner=lambda cmd, cwd=None: run(cmd, env=None) if cwd is None else subprocess.run(
            cmd,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
        ),
    )
    if SWARM_ENABLED and not swarm.validate_or_warn():
        return 1

    history = load_history()

    log.info("=" * 60)
    log.info("DARWIN AUTORESEARCH — Starting")
    log.info("Model: %s", MODEL)
    log.info("Reasoning effort: %s", REASONING_EFFORT or "default")
    log.info("Target app: %s", TARGET_APP)
    log.info("Experiment budget: %s minutes each", EXPERIMENT_MIN)
    log.info("Minimum trades per window: %s", MIN_TRADES)
    log.info("Validation windows per keeper: %s", VALIDATION_WINDOWS)
    log.info("Tunable files: %s", ", ".join(TUNABLE_FILES))
    if SWARM_ENABLED:
        log.info("Swarm mode: enabled")
        log.info("Swarm runner: %s", os.getenv("AUTORESEARCH_RUNNER_ID", "").strip() or "<missing>")
        log.info("Coord branch: %s", os.getenv("AUTORESEARCH_COORD_BRANCH", "swarm/state"))
        log.info("Research branch: %s", os.getenv("AUTORESEARCH_RESEARCH_BRANCH", "research/current"))
    if MIRROR_DIR:
        log.info("Mirror worktree: %s%s", MIRROR_DIR, " (auto-push)" if PUSH_AFTER_KEEP else "")
    log.info("=" * 60)

    if SWARM_ENABLED:
        swarm.flush_pending()
        adopted = swarm.adopt_best_if_ahead()
        if adopted:
            changed_files = adopted.get("changed_files", [])
            log.info(
                "  [swarm] Adopted research best %s (%s files)",
                adopted.get("branch_commit"),
                len(changed_files),
            )

    if not rebuild():
        return 1
    if not restart_target_app():
        log.error("Failed to start healthy paper target app %s.", TARGET_APP)
        return 1

    baseline_window = collect_window_metrics("BASELINE")
    baseline = baseline_window["assessment"]
    log.info("  BASELINE: %s", summarize_assessment(baseline))

    for experiment_num in range(1, MAX_EXPERIMENTS + 1):
        if SWARM_ENABLED and (experiment_num - 1) % swarm.sync_every_experiments == 0:
            swarm.flush_pending()
            adopted = swarm.adopt_best_if_ahead()
            if adopted:
                log.info("  [swarm] Synced newer research best; refreshing baseline.")
                if not rebuild():
                    return 1
                if not restart_target_app():
                    return 1
                baseline_window = collect_window_metrics("BASELINE")
                baseline = baseline_window["assessment"]

        file_path = pick_file(experiment_num, baseline)
        experiment_baseline = json.loads(json.dumps(baseline))
        label = f"exp{experiment_num:03d}"

        if file_is_dirty(file_path):
            log.error("Refusing to modify dirty file: %s", file_path)
            return 1

        current_code = read_file(file_path)
        prompt = build_prompt(file_path, current_code, baseline, history)

        log.info("%s", "\n" + "=" * 60)
        log.info("EXPERIMENT %s — modifying %s", experiment_num, file_path)
        log.info("Current baseline: %s", summarize_assessment(experiment_baseline))
        log.info("%s", "=" * 60)

        try:
            raw = ask_openai(prompt)
        except Exception as exc:
            log.error("  OpenAI API error: %s", exc)
            time.sleep(60)
            continue

        hypothesis = ""
        if "HYPOTHESIS:" in raw:
            hypothesis = raw.split("HYPOTHESIS:", 1)[1].split("---FILE---", 1)[0].strip()
        new_code = extract_code(raw)
        log.info("  Hypothesis: %s", hypothesis[:240])

        claim: ClaimRecord | None = None
        if SWARM_ENABLED:
            claim = swarm.claim(file_path, hypothesis or f"{label}-{file_path}")
            if claim is None:
                history.append({
                    "exp": experiment_num,
                    "file": file_path,
                    "hypothesis": hypothesis[:240],
                    "result": "claim_denied",
                })
                save_history(history)
                continue

        write_file(file_path, new_code)
        build_result = run("npm run build")
        if build_result.returncode != 0:
            errors = (build_result.stdout + build_result.stderr)[-2000:]
            error_context = extract_error_context(file_path, errors)
            log.warning("  Build failed. Requesting focused correction...")
            try:
                fix_raw = ask_openai(build_fix_prompt(errors, error_context, hypothesis, file_path))
                write_file(file_path, extract_code(fix_raw))
                if run("npm run build").returncode != 0:
                    aggregate_result = failure_assessment("build_failed_x2")
                    result_payload = build_result_payload(
                        experiment_id=claim.experiment_id if claim else label,
                        file_path=file_path,
                        hypothesis=hypothesis,
                        baseline=experiment_baseline,
                        aggregate_result=aggregate_result,
                        window_results=[],
                        kept=False,
                        reason="build_failed_x2",
                        commit_sha=swarm._current_commit(DARWIN_DIR) if swarm else "unknown",
                        branch=swarm._current_branch(DARWIN_DIR) if swarm else "unknown",
                    )
                    if SWARM_ENABLED:
                        swarm.publish_result(result_payload)
                        swarm.publish_insight(build_insight_payload(
                            experiment_id=result_payload["experiment_id"],
                            file_path=file_path,
                            kept=False,
                            reason="build_failed_x2",
                            aggregate_result=aggregate_result,
                            baseline=baseline,
                        ))
                        swarm.publish_hypothesis(build_hypothesis_payload(
                            experiment_id=result_payload["experiment_id"],
                            file_path=file_path,
                            kept=False,
                            reason="build_failed_x2",
                            aggregate_result=aggregate_result,
                            baseline=baseline,
                        ))
                        swarm.release_claim(claim, "build_failed_x2")
                    history.append({
                        "exp": experiment_num,
                        "file": file_path,
                        "hypothesis": hypothesis,
                        "result": "build_failed_x2",
                    })
                    save_history(history)
                    if not revert_file(file_path, current_code):
                        return 1
                    continue
            except Exception as exc:
                log.error("  Self-correction failed: %s", exc)
                aggregate_result = failure_assessment("build_failed")
                result_payload = build_result_payload(
                    experiment_id=claim.experiment_id if claim else label,
                    file_path=file_path,
                    hypothesis=hypothesis,
                    baseline=experiment_baseline,
                    aggregate_result=aggregate_result,
                    window_results=[],
                    kept=False,
                    reason="build_failed",
                    commit_sha=swarm._current_commit(DARWIN_DIR) if swarm else "unknown",
                    branch=swarm._current_branch(DARWIN_DIR) if swarm else "unknown",
                )
                if SWARM_ENABLED:
                    swarm.publish_result(result_payload)
                    swarm.publish_insight(build_insight_payload(
                        experiment_id=result_payload["experiment_id"],
                        file_path=file_path,
                        kept=False,
                        reason="build_failed",
                        aggregate_result=aggregate_result,
                        baseline=baseline,
                    ))
                    swarm.publish_hypothesis(build_hypothesis_payload(
                        experiment_id=result_payload["experiment_id"],
                        file_path=file_path,
                        kept=False,
                        reason="build_failed",
                        aggregate_result=aggregate_result,
                        baseline=baseline,
                    ))
                    swarm.release_claim(claim, "build_failed")
                history.append({
                    "exp": experiment_num,
                    "file": file_path,
                    "hypothesis": hypothesis,
                    "result": "build_failed",
                })
                save_history(history)
                if not revert_file(file_path, current_code):
                    return 1
                continue

        if not restart_target_app():
            log.error("  Target app failed health check after applying %s. Reverting.", file_path)
            aggregate_result = failure_assessment("health_failed")
            result_payload = build_result_payload(
                experiment_id=claim.experiment_id if claim else label,
                file_path=file_path,
                hypothesis=hypothesis,
                baseline=experiment_baseline,
                aggregate_result=aggregate_result,
                window_results=[],
                kept=False,
                reason="health_failed",
                commit_sha=swarm._current_commit(DARWIN_DIR) if swarm else "unknown",
                branch=swarm._current_branch(DARWIN_DIR) if swarm else "unknown",
            )
            if SWARM_ENABLED:
                swarm.publish_result(result_payload)
                swarm.publish_insight(build_insight_payload(
                    experiment_id=result_payload["experiment_id"],
                    file_path=file_path,
                    kept=False,
                    reason="health_failed",
                    aggregate_result=aggregate_result,
                    baseline=baseline,
                ))
                swarm.publish_hypothesis(build_hypothesis_payload(
                    experiment_id=result_payload["experiment_id"],
                    file_path=file_path,
                    kept=False,
                    reason="health_failed",
                    aggregate_result=aggregate_result,
                    baseline=baseline,
                ))
                swarm.release_claim(claim, "health_failed")
            history.append({
                "exp": experiment_num,
                "file": file_path,
                "hypothesis": hypothesis,
                "result": "health_failed",
            })
            save_history(history)
            if not revert_file(file_path, current_code):
                return 1
            continue

        window_results: list[dict] = []
        aggregate_result: dict | None = None
        candidate_start_ms: int | None = None

        for window_num in range(1, VALIDATION_WINDOWS + 1):
            collected = collect_window_metrics(f"WINDOW {window_num}", claim)
            window_assessment = collected["assessment"]
            window_results.append(window_assessment)
            candidate_start_ms = candidate_start_ms or collected["since_ts_ms"]
            aggregate_result = eval_window(candidate_start_ms, claim)
            log.info("  Aggregate after window %s: %s", window_num, summarize_assessment(aggregate_result))
            if window_assessment.get("tier") == "hard_fail":
                log.info("  Window %s hard-failed; stopping validation early.", window_num)
                break

        if aggregate_result is None:
            aggregate_result = {
                "tier": "hard_fail",
                "rank_key": [],
                "bankroll_growth_pct": -999,
                "migration_win_rate": 0,
                "no_pump_bail_pct": 100,
                "max_drawdown_pct": 100,
            }

        improved, reason = candidate_passes(baseline, aggregate_result, window_results)
        log.info(
            "  Aggregate verdict: %s -> %s (%s)",
            summarize_assessment(experiment_baseline),
            summarize_assessment(aggregate_result),
            reason,
        )

        if improved:
            baseline = aggregate_result
            commit_message = (
                f"auto[{label}]: {file_path} "
                f"{baseline.get('tier', '?')} "
                f"growth {float(baseline.get('bankroll_growth_pct', 0)):.2f}% | "
                f"{hypothesis[:70]}"
            )
            git_commit(file_path, commit_message)
            if SWARM_ENABLED:
                result_commit = swarm._current_commit(DARWIN_DIR)
                best_payload = {
                    "experiment_id": claim.experiment_id if claim else label,
                    "runner_id": os.getenv("AUTORESEARCH_RUNNER_ID", "").strip() or "unknown",
                    "target_file": file_path,
                    "hypothesis_slug": normalize_hypothesis_slug(hypothesis),
                    "commit_sha": result_commit,
                    "branch": os.getenv("AUTORESEARCH_RESEARCH_BRANCH", "research/current"),
                    "assessment": aggregate_result,
                }
                promoted_commit = swarm.promote_keeper(file_path, commit_message, best_payload)
                if promoted_commit:
                    baseline["branch_commit"] = promoted_commit
            elif not mirror_kept_change(file_path, commit_message):
                log.warning("  Keeper mirrored locally but not to mirror worktree.")
        else:
            if not revert_file(file_path, current_code):
                return 1

        result_payload = build_result_payload(
            experiment_id=claim.experiment_id if claim else label,
            file_path=file_path,
            hypothesis=hypothesis,
            baseline=experiment_baseline,
            aggregate_result=aggregate_result,
            window_results=window_results,
            kept=improved,
            reason=reason,
            commit_sha=swarm._current_commit(DARWIN_DIR) if swarm else "unknown",
            branch=swarm._current_branch(DARWIN_DIR) if swarm else "unknown",
        )
        if SWARM_ENABLED:
            swarm.publish_result(result_payload)
            swarm.publish_insight(build_insight_payload(
                experiment_id=result_payload["experiment_id"],
                file_path=file_path,
                kept=improved,
                reason=reason,
                aggregate_result=aggregate_result,
                baseline=experiment_baseline,
            ))
            swarm.publish_hypothesis(build_hypothesis_payload(
                experiment_id=result_payload["experiment_id"],
                file_path=file_path,
                kept=improved,
                reason=reason,
                aggregate_result=aggregate_result,
                baseline=experiment_baseline,
            ))
            swarm.release_claim(claim, "keeper" if improved else "discard")

        history.append({
            "exp": experiment_num,
            "file": file_path,
            "hypothesis": hypothesis[:240],
            "baseline": baseline,
            "result": aggregate_result,
            "windows": window_results,
            "kept": improved,
            "reason": reason,
        })
        save_history(history)

    log.info("AUTORESEARCH COMPLETE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
