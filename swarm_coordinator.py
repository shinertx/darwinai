#!/usr/bin/env python3
"""
GitHub-backed swarm coordination for Darwin autoresearch.

The coordinator uses a clean Git worktree to maintain two repo branches:
  - swarm/state: branch-backed swarm memory
  - research/current: auto-promoted research keeper branch

If GitHub is unavailable, publications are written to a local pending queue and
replayed later. The coordinator never blocks the local experiment loop.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _utcnow().isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def _slugify(value: str, max_len: int = 80) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return (slug or "na")[:max_len].rstrip("-") or "na"


def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


@dataclass
class ClaimRecord:
    experiment_id: str
    runner_id: str
    target_file: str
    hypothesis_slug: str
    claim_expires_at: str
    active_path: str
    runner_path: str
    offline: bool = False


class GitHubSwarmCoordinator:
    def __init__(
        self,
        *,
        darwin_dir: Path,
        tunable_files: list[str],
        logger: Callable[[str], None] | None = None,
        runner: Callable[[str, Path | None], subprocess.CompletedProcess[str]] | None = None,
    ) -> None:
        self.darwin_dir = darwin_dir
        self.tunable_files = tunable_files
        self.log = logger or (lambda message: None)
        self._runner = runner or self._default_runner

        self.enabled = self._env_flag("AUTORESEARCH_ENABLE_SWARM", False)
        self.runner_id = os.getenv("AUTORESEARCH_RUNNER_ID", "").strip()
        self.coord_branch = os.getenv("AUTORESEARCH_COORD_BRANCH", "swarm/state").strip() or "swarm/state"
        self.research_branch = os.getenv("AUTORESEARCH_RESEARCH_BRANCH", "research/current").strip() or "research/current"
        self.push_remote = os.getenv("AUTORESEARCH_PUSH_REMOTE", "origin").strip() or "origin"
        coord_worktree = os.getenv("AUTORESEARCH_COORD_WORKTREE", "").strip()
        self.coord_worktree = Path(coord_worktree).expanduser() if coord_worktree else None
        self.claim_ttl_min = max(1, int(os.getenv("AUTORESEARCH_CLAIM_TTL_MIN", "45")))
        self.claim_heartbeat_min = max(1, int(os.getenv("AUTORESEARCH_CLAIM_HEARTBEAT_MIN", "5")))
        self.sync_every_experiments = max(1, int(os.getenv("AUTORESEARCH_SYNC_EVERY_EXPERIMENTS", "1")))

        self.local_state_dir = self.darwin_dir / ".autoresearch-swarm"
        self.pending_dir = self.local_state_dir / "pending"
        self.state_file = self.local_state_dir / "state.json"
        self.pending_dir.mkdir(parents=True, exist_ok=True)
        self._last_heartbeat_at: dict[str, float] = {}

    @staticmethod
    def _default_runner(cmd: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            cmd,
            shell=True,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
        )

    @staticmethod
    def _env_flag(name: str, default: bool = False) -> bool:
        value = os.getenv(name)
        if value is None:
            return default
        return value.strip().lower() in {"1", "true", "yes", "on"}

    def validate_or_warn(self) -> bool:
        if not self.enabled:
            return True
        missing: list[str] = []
        if not self.runner_id:
            missing.append("AUTORESEARCH_RUNNER_ID")
        if not self.coord_worktree:
            missing.append("AUTORESEARCH_COORD_WORKTREE")
        if missing:
            self.log(f"Swarm disabled in practice; missing required env: {', '.join(missing)}")
            return False
        return True

    def _run(self, cmd: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return self._runner(cmd, cwd)

    def _load_local_state(self) -> dict[str, Any]:
        if not self.state_file.exists():
            return {}
        try:
            return json.loads(self.state_file.read_text())
        except Exception:
            return {}

    def _save_local_state(self, payload: dict[str, Any]) -> None:
        self.state_file.write_text(_json_dumps(payload))

    def _queue_action(self, action: str, payload: dict[str, Any]) -> None:
        timestamp = _utcnow().strftime("%Y%m%dT%H%M%S%fZ")
        slug = _slugify(payload.get("experiment_id") or payload.get("slug") or action)
        queue_path = self.pending_dir / f"{timestamp}-{action}-{slug}.json"
        queue_path.write_text(_json_dumps({"action": action, "payload": payload, "queued_at": _iso_now()}))
        self.log(f"Queued swarm action locally: {queue_path.name}")

    def github_available(self) -> bool:
        if not self.enabled or not self.coord_worktree:
            return False

        remote_probe = self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} ls-remote {shlex.quote(self.push_remote)} HEAD"
        )
        if remote_probe.returncode != 0:
            return False

        origin_url = self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} remote get-url {shlex.quote(self.push_remote)}"
        )
        if origin_url.returncode == 0 and origin_url.stdout.strip().startswith("file://"):
            return True

        gh_status = self._run("gh auth status")
        return gh_status.returncode == 0

    def _require_clean_worktree(self) -> bool:
        if not self.coord_worktree:
            return False
        status = self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} status --porcelain"
        )
        return status.returncode == 0 and not status.stdout.strip()

    def _ensure_branch_checked_out(self, branch: str) -> bool:
        if not self.coord_worktree:
            return False
        worktree = shlex.quote(str(self.coord_worktree))
        remote = shlex.quote(self.push_remote)
        branch_q = shlex.quote(branch)
        remote_ref_name = f"{self.push_remote}/{branch}"

        if not self._require_clean_worktree():
            self.log(f"Coordination worktree is dirty: {self.coord_worktree}")
            return False

        self._run(f"git -C {worktree} fetch {remote} --prune")
        remote_ref = self._run(f"git -C {worktree} rev-parse --verify {shlex.quote(remote_ref_name)}")
        if remote_ref.returncode == 0:
            checkout = self._run(f"git -C {worktree} checkout {branch_q}")
            if checkout.returncode != 0:
                checkout = self._run(
                    f"git -C {worktree} checkout -B {branch_q} {shlex.quote(remote_ref_name)}"
                )
            if checkout.returncode != 0:
                return False
            pull = self._run(f"git -C {worktree} pull --ff-only {remote} {branch_q}")
            return pull.returncode == 0 or "Already up to date." in (pull.stdout + pull.stderr)

        base_ref_name = f"{self.push_remote}/main"
        base_ref = self._run(f"git -C {worktree} rev-parse --verify {shlex.quote(base_ref_name)}")
        if base_ref.returncode != 0:
            self._run(f"git -C {worktree} fetch {remote} main")
        checkout = self._run(f"git -C {worktree} checkout -B {branch_q} {shlex.quote(base_ref_name)}")
        return checkout.returncode == 0

    def _commit_and_push(self, message: str) -> bool:
        if not self.coord_worktree:
            return False
        worktree = shlex.quote(str(self.coord_worktree))
        branch_name = self._run(f"git -C {worktree} branch --show-current")
        branch = (branch_name.stdout or "").strip()
        if not branch:
            return False
        staged = self._run(f"git -C {worktree} diff --cached --quiet")
        if staged.returncode == 0:
            return True

        commit = self._run(f"git -C {worktree} commit -m {shlex.quote(message)}")
        if commit.returncode != 0:
            self.log(f"Swarm commit failed: {(commit.stdout + commit.stderr)[-500:]}")
            return False

        push = self._run(
            f"git -C {worktree} push {shlex.quote(self.push_remote)} {shlex.quote(branch)}"
        )
        if push.returncode == 0:
            return True

        # Retry once after rebase for non-conflicting concurrent state pushes.
        rebase = self._run(
            f"git -C {worktree} pull --rebase {shlex.quote(self.push_remote)} {shlex.quote(branch)}"
        )
        if rebase.returncode != 0:
            self.log(f"Swarm rebase failed: {(rebase.stdout + rebase.stderr)[-500:]}")
            return False
        push = self._run(
            f"git -C {worktree} push {shlex.quote(self.push_remote)} {shlex.quote(branch)}"
        )
        if push.returncode != 0:
            self.log(f"Swarm push failed: {(push.stdout + push.stderr)[-500:]}")
            return False
        return True

    def _ensure_state_bootstrap(self) -> None:
        if not self.coord_worktree:
            return
        branch_root = self.coord_worktree / "swarm"
        branch_root.mkdir(parents=True, exist_ok=True)
        stable_candidate = self.coord_worktree / "swarm" / "best" / "stable-candidate.json"
        research_best = self.coord_worktree / "swarm" / "best" / "research.json"
        stable_candidate.parent.mkdir(parents=True, exist_ok=True)
        if not stable_candidate.exists():
            stable_candidate.write_text(_json_dumps({
                "updated_at": _iso_now(),
                "note": "Manual pointer only. Stable promotion is human-controlled.",
                "branch": "main",
            }))
        if not research_best.exists():
            research_best.write_text(_json_dumps({
                "updated_at": _iso_now(),
                "branch": self.research_branch,
                "branch_commit": None,
                "experiment_id": None,
                "runner_id": None,
                "target_file": None,
                "hypothesis_slug": None,
                "assessment": None,
            }))
        self._run(f"git -C {shlex.quote(str(self.coord_worktree))} add -- swarm/best")

    def _experiment_id(self, target_file: str, hypothesis_slug: str) -> str:
        normalized_target = _slugify(target_file.replace("/", "-"), 80)
        material = f"{target_file}|{hypothesis_slug}".encode("utf-8")
        short_hash = hashlib.sha1(material).hexdigest()[:10]
        return f"{normalized_target}--{hypothesis_slug}--{short_hash}"

    def _read_json_if_exists(self, path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text())
        except Exception:
            return None

    def claim(self, target_file: str, hypothesis_text: str) -> ClaimRecord | None:
        hypothesis_slug = _slugify(hypothesis_text or "no-hypothesis")
        experiment_id = self._experiment_id(target_file, hypothesis_slug)
        expires_at = _utcnow() + timedelta(minutes=self.claim_ttl_min)

        if not self.enabled:
            return ClaimRecord(
                experiment_id=experiment_id,
                runner_id=self.runner_id or "solo",
                target_file=target_file,
                hypothesis_slug=hypothesis_slug,
                claim_expires_at=expires_at.isoformat(),
                active_path="",
                runner_path="",
                offline=True,
            )

        if not self.github_available():
            self.log("Swarm unavailable during claim; continuing solo.")
            return ClaimRecord(
                experiment_id=experiment_id,
                runner_id=self.runner_id,
                target_file=target_file,
                hypothesis_slug=hypothesis_slug,
                claim_expires_at=expires_at.isoformat(),
                active_path="",
                runner_path="",
                offline=True,
            )

        if not self._ensure_branch_checked_out(self.coord_branch):
            self.log("Unable to check out swarm coordination branch; continuing solo.")
            return ClaimRecord(
                experiment_id=experiment_id,
                runner_id=self.runner_id,
                target_file=target_file,
                hypothesis_slug=hypothesis_slug,
                claim_expires_at=expires_at.isoformat(),
                active_path="",
                runner_path="",
                offline=True,
            )

        self._ensure_state_bootstrap()

        active_path = self.coord_worktree / "swarm" / "claims" / "_active" / f"{experiment_id}.json"
        runner_path = self.coord_worktree / "swarm" / "claims" / self.runner_id / f"{experiment_id}.json"
        active_path.parent.mkdir(parents=True, exist_ok=True)
        runner_path.parent.mkdir(parents=True, exist_ok=True)

        active = self._read_json_if_exists(active_path)
        active_expiry = _parse_iso(active.get("claim_expires_at") if active else None)
        if active and active.get("runner_id") != self.runner_id and active_expiry and active_expiry > _utcnow():
            self.log(
                f"Swarm claim denied for {experiment_id}; active owner is {active.get('runner_id')}"
            )
            return None

        claim_payload = {
            "experiment_id": experiment_id,
            "runner_id": self.runner_id,
            "target_file": target_file,
            "hypothesis_slug": hypothesis_slug,
            "claim_expires_at": expires_at.isoformat(),
            "claimed_at": _iso_now(),
            "branch": self._current_branch(self.darwin_dir),
        }
        active_path.write_text(_json_dumps(claim_payload))
        runner_path.write_text(_json_dumps(claim_payload))
        runner_meta = self.coord_worktree / "swarm" / "runners" / f"{self.runner_id}.json"
        runner_meta.parent.mkdir(parents=True, exist_ok=True)
        runner_meta.write_text(_json_dumps({
            "runner_id": self.runner_id,
            "updated_at": _iso_now(),
            "status": "claimed",
            "experiment_id": experiment_id,
            "target_file": target_file,
        }))
        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -- {shlex.quote(str(active_path.relative_to(self.coord_worktree)))} {shlex.quote(str(runner_path.relative_to(self.coord_worktree)))} {shlex.quote(str(runner_meta.relative_to(self.coord_worktree)))}"
        )
        if not self._commit_and_push(f"swarm claim: {experiment_id} by {self.runner_id}"):
            self.log("Swarm claim push failed; falling back to solo mode for this experiment.")
            return ClaimRecord(
                experiment_id=experiment_id,
                runner_id=self.runner_id,
                target_file=target_file,
                hypothesis_slug=hypothesis_slug,
                claim_expires_at=expires_at.isoformat(),
                active_path=str(active_path.relative_to(self.coord_worktree)),
                runner_path=str(runner_path.relative_to(self.coord_worktree)),
                offline=True,
            )

        self._last_heartbeat_at[experiment_id] = time.time()
        return ClaimRecord(
            experiment_id=experiment_id,
            runner_id=self.runner_id,
            target_file=target_file,
            hypothesis_slug=hypothesis_slug,
            claim_expires_at=expires_at.isoformat(),
            active_path=str(active_path.relative_to(self.coord_worktree)),
            runner_path=str(runner_path.relative_to(self.coord_worktree)),
        )

    def heartbeat(self, claim: ClaimRecord | None) -> None:
        if not claim or claim.offline or not self.enabled:
            return
        last = self._last_heartbeat_at.get(claim.experiment_id, 0)
        if time.time() - last < self.claim_heartbeat_min * 60:
            return
        if not self.github_available() or not self._ensure_branch_checked_out(self.coord_branch):
            return

        active_path = self.coord_worktree / claim.active_path
        runner_path = self.coord_worktree / claim.runner_path
        current = self._read_json_if_exists(active_path) or {}
        if current.get("runner_id") != self.runner_id:
            return
        expires_at = _utcnow() + timedelta(minutes=self.claim_ttl_min)
        current["claim_expires_at"] = expires_at.isoformat()
        current["heartbeat_at"] = _iso_now()
        active_path.write_text(_json_dumps(current))
        runner_path.write_text(_json_dumps(current))
        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -- {shlex.quote(str(active_path.relative_to(self.coord_worktree)))} {shlex.quote(str(runner_path.relative_to(self.coord_worktree)))}"
        )
        if self._commit_and_push(f"swarm heartbeat: {claim.experiment_id}"):
            self._last_heartbeat_at[claim.experiment_id] = time.time()

    def release_claim(self, claim: ClaimRecord | None, status: str) -> None:
        if not claim or claim.offline or not self.enabled:
            return
        if not self.github_available() or not self._ensure_branch_checked_out(self.coord_branch):
            return
        active_path = self.coord_worktree / claim.active_path
        runner_path = self.coord_worktree / claim.runner_path
        if active_path.exists():
            current = self._read_json_if_exists(active_path) or {}
            if current.get("runner_id") == self.runner_id:
                active_path.unlink()
        if runner_path.exists():
            current = self._read_json_if_exists(runner_path) or {}
            current["released_at"] = _iso_now()
            current["status"] = status
            runner_path.write_text(_json_dumps(current))
        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -A -- swarm/claims"
        )
        self._commit_and_push(f"swarm release: {claim.experiment_id} ({status})")

    def flush_pending(self) -> None:
        if not self.enabled or not self.github_available():
            return
        pending = sorted(self.pending_dir.glob("*.json"))
        for item in pending:
            try:
                payload = json.loads(item.read_text())
                action = payload.get("action")
                body = payload.get("payload", {})
                if action == "publish_result":
                    self._publish_result(body, allow_queue=False)
                elif action == "publish_insight":
                    self._publish_insight(body, allow_queue=False)
                elif action == "publish_hypothesis":
                    self._publish_hypothesis(body, allow_queue=False)
                elif action == "update_best":
                    self._update_best(body, allow_queue=False)
                else:
                    self.log(f"Unknown pending swarm action: {item.name}")
                item.unlink(missing_ok=True)
            except Exception as exc:
                self.log(f"Pending swarm replay failed for {item.name}: {exc}")
                break

    def _current_branch(self, cwd: Path) -> str:
        branch = self._run("git branch --show-current", cwd)
        return (branch.stdout or "").strip() or "unknown"

    def _current_commit(self, cwd: Path) -> str:
        commit = self._run("git rev-parse --short HEAD", cwd)
        return (commit.stdout or "").strip() or "unknown"

    def _repo_slug(self) -> str | None:
        if not self.coord_worktree:
            return None
        repo = self._run("gh repo view --json nameWithOwner -q .nameWithOwner", self.coord_worktree)
        if repo.returncode == 0 and repo.stdout.strip():
            return repo.stdout.strip()
        return None

    def publish_result(self, payload: dict[str, Any]) -> None:
        self._publish_result(payload, allow_queue=True)

    def _publish_result(self, payload: dict[str, Any], allow_queue: bool) -> None:
        if not self.enabled:
            return
        if not self.github_available():
            if allow_queue:
                self._queue_action("publish_result", payload)
            return
        if not self._ensure_branch_checked_out(self.coord_branch):
            if allow_queue:
                self._queue_action("publish_result", payload)
            return
        self._ensure_state_bootstrap()

        stamp = _utcnow().strftime("%Y%m%dT%H%M%SZ")
        result_path = self.coord_worktree / "swarm" / "results" / self.runner_id / f"{stamp}-{payload['experiment_id']}.json"
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(_json_dumps(payload))

        runner_meta = self.coord_worktree / "swarm" / "runners" / f"{self.runner_id}.json"
        runner_meta.parent.mkdir(parents=True, exist_ok=True)
        runner_meta.write_text(_json_dumps({
            "runner_id": self.runner_id,
            "updated_at": _iso_now(),
            "status": "published",
            "last_result": result_path.name,
            "target_file": payload.get("target_file"),
            "keeper": payload.get("keeper"),
            "tier": payload.get("tier"),
        }))

        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -- {shlex.quote(str(result_path.relative_to(self.coord_worktree)))} {shlex.quote(str(runner_meta.relative_to(self.coord_worktree)))}"
        )
        if not self._commit_and_push(f"swarm result: {payload['experiment_id']} ({payload.get('tier')})") and allow_queue:
            self._queue_action("publish_result", payload)

    def publish_insight(self, payload: dict[str, Any]) -> None:
        self._publish_insight(payload, allow_queue=True)

    def _publish_insight(self, payload: dict[str, Any], allow_queue: bool) -> None:
        if not self.enabled:
            return
        if not self.github_available():
            if allow_queue:
                self._queue_action("publish_insight", payload)
            return
        if not self._ensure_branch_checked_out(self.coord_branch):
            if allow_queue:
                self._queue_action("publish_insight", payload)
            return
        stamp = _utcnow().strftime("%Y%m%dT%H%M%SZ")
        slug = _slugify(payload.get("slug") or payload.get("experiment_id") or "insight")
        insight_path = self.coord_worktree / "swarm" / "insights" / self.runner_id / f"{stamp}-{slug}.md"
        insight_path.parent.mkdir(parents=True, exist_ok=True)
        body = (
            f"# Insight: {payload.get('title', slug)}\n\n"
            f"- runner: `{self.runner_id}`\n"
            f"- experiment_id: `{payload.get('experiment_id')}`\n"
            f"- target_file: `{payload.get('target_file')}`\n"
            f"- keeper: `{payload.get('keeper')}`\n"
            f"- tier: `{payload.get('tier')}`\n"
            f"- created_at: `{_iso_now()}`\n\n"
            f"{payload.get('body', '').strip()}\n"
        )
        insight_path.write_text(body)
        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -- {shlex.quote(str(insight_path.relative_to(self.coord_worktree)))}"
        )
        if not self._commit_and_push(f"swarm insight: {payload.get('experiment_id')}") and allow_queue:
            self._queue_action("publish_insight", payload)

    def publish_hypothesis(self, payload: dict[str, Any]) -> None:
        self._publish_hypothesis(payload, allow_queue=True)

    def _publish_hypothesis(self, payload: dict[str, Any], allow_queue: bool) -> None:
        if not self.enabled:
            return
        if not self.github_available():
            if allow_queue:
                self._queue_action("publish_hypothesis", payload)
            return
        if not self._ensure_branch_checked_out(self.coord_branch):
            if allow_queue:
                self._queue_action("publish_hypothesis", payload)
            return
        stamp = _utcnow().strftime("%Y%m%dT%H%M%SZ")
        slug = _slugify(payload.get("slug") or payload.get("experiment_id") or "hypothesis")
        hypothesis_path = self.coord_worktree / "swarm" / "hypotheses" / self.runner_id / f"{stamp}-{slug}.json"
        hypothesis_path.parent.mkdir(parents=True, exist_ok=True)
        hypothesis_path.write_text(_json_dumps(payload))
        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -- {shlex.quote(str(hypothesis_path.relative_to(self.coord_worktree)))}"
        )
        if not self._commit_and_push(f"swarm hypothesis: {payload.get('experiment_id')}") and allow_queue:
            self._queue_action("publish_hypothesis", payload)

    def promote_keeper(self, file_path: str, commit_message: str, best_payload: dict[str, Any]) -> str | None:
        if not self.enabled:
            return None
        if not self.github_available():
            self._queue_action("update_best", best_payload)
            return None

        if not self._ensure_branch_checked_out(self.research_branch):
            self.log("Unable to check out research branch for keeper promotion.")
            return None

        source_path = self.darwin_dir / file_path
        target_path = self.coord_worktree / file_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(source_path.read_text())
        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -- {shlex.quote(file_path)}"
        )
        if not self._commit_and_push(commit_message):
            self.log("Keeper promotion push failed.")
            return None

        commit_sha = self._current_commit(self.coord_worktree)
        payload = dict(best_payload)
        payload["branch"] = self.research_branch
        payload["branch_commit"] = commit_sha
        self._update_best(payload, allow_queue=True)
        return commit_sha

    def _update_best(self, payload: dict[str, Any], allow_queue: bool) -> None:
        if not self.enabled:
            return
        if not self.github_available():
            if allow_queue:
                self._queue_action("update_best", payload)
            return
        if not self._ensure_branch_checked_out(self.coord_branch):
            if allow_queue:
                self._queue_action("update_best", payload)
            return
        self._ensure_state_bootstrap()
        best_path = self.coord_worktree / "swarm" / "best" / "research.json"
        current = self._read_json_if_exists(best_path) or {}
        current_assessment = current.get("assessment") or {}
        incoming_assessment = payload.get("assessment") or {}
        current_rank = tuple(float(x) for x in current_assessment.get("rank_key", []))
        incoming_rank = tuple(float(x) for x in incoming_assessment.get("rank_key", []))
        current_tier = current_assessment.get("tier", "hard_fail")
        incoming_tier = incoming_assessment.get("tier", "hard_fail")
        tier_order = {"hard_fail": 0, "tier_c": 1, "tier_b": 2, "tier_a": 3}
        if (
            tier_order.get(incoming_tier, 0) < tier_order.get(current_tier, 0)
            or (
                tier_order.get(incoming_tier, 0) == tier_order.get(current_tier, 0)
                and incoming_rank <= current_rank
            )
        ):
            return

        payload = dict(payload)
        payload["updated_at"] = _iso_now()
        best_path.write_text(_json_dumps(payload))
        self._run(
            f"git -C {shlex.quote(str(self.coord_worktree))} add -- {shlex.quote(str(best_path.relative_to(self.coord_worktree)))}"
        )
        if not self._commit_and_push(f"swarm best: {payload.get('experiment_id')} -> {payload.get('tier')}") and allow_queue:
            self._queue_action("update_best", payload)

    def get_best_research_state(self) -> dict[str, Any] | None:
        if not self.enabled or not self.github_available():
            return None
        self.flush_pending()
        if not self._ensure_branch_checked_out(self.coord_branch):
            return None
        best_path = self.coord_worktree / "swarm" / "best" / "research.json"
        return self._read_json_if_exists(best_path)

    def adopt_best_if_ahead(self) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        best = self.get_best_research_state()
        if not best:
            return None
        branch_commit = (best.get("branch_commit") or "").strip()
        if not branch_commit:
            return None
        local_state = self._load_local_state()
        if local_state.get("last_adopted_research_commit") == branch_commit:
            return None
        if not self.coord_worktree or not self._ensure_branch_checked_out(self.research_branch):
            return None

        changed_files: list[str] = []
        for file_path in self.tunable_files:
            source = self.coord_worktree / file_path
            if not source.exists():
                continue
            target = self.darwin_dir / file_path
            if not target.exists():
                continue
            source_text = source.read_text()
            target_text = target.read_text()
            if source_text != target_text:
                target.write_text(source_text)
                changed_files.append(file_path)

        if changed_files:
            quoted_files = " ".join(shlex.quote(path) for path in changed_files)
            self._run(f"git add -- {quoted_files}", self.darwin_dir)
            self._run(
                f"git commit -m {shlex.quote(f'swarm-sync: adopt {self.research_branch} {branch_commit}')} -- {quoted_files}",
                self.darwin_dir,
            )

        local_state["last_adopted_research_commit"] = branch_commit
        local_state["last_adopted_at"] = _iso_now()
        self._save_local_state(local_state)

        return {
            "branch_commit": branch_commit,
            "changed_files": changed_files,
            "best": best,
        }
