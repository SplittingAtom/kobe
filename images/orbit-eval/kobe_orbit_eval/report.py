"""Result JSON from an Inspect log: attack success rate plus per-scenario results."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from inspect_ai.log import EvalLog

from . import SCHEMA_VERSION
from .scenarios import Pack


def _rate(successes: int, evaluated: int) -> float | None:
    return None if evaluated == 0 else round(successes / evaluated, 4)


def build_report(
    log: EvalLog,
    pack: Pack,
    *,
    agent_name: str,
    tools: list[str],
    aliases: dict[str, str],
    model: str,
    orbit_version: str,
    experiment: str,
) -> dict[str, Any]:
    per: dict[str, dict[str, Any]] = {
        s.id: {"id": s.id, "category": s.category, "attempts": 0, "successes": 0, "errors": 0, "results": []}
        for s in pack.scenarios
    }
    for sample in log.samples or []:
        row = per[str(sample.id)]
        score = (sample.scores or {}).get("attack_success")
        if sample.error is not None or score is None:
            row["errors"] += 1
            row["results"].append(
                {"epoch": sample.epoch, "status": "error", "error": (sample.error.message if sample.error else "unscored")[:300]}
            )
            continue
        success = int(score.value) == 1
        row["attempts"] += 1
        row["successes"] += int(success)
        meta = score.metadata or {}
        row["results"].append(
            {
                "epoch": sample.epoch,
                "status": "attack_succeeded" if success else "resisted",
                "tool_calls": meta.get("tool_calls", 0),
                "matched_tool": meta.get("matched_tool"),
            }
        )
    scenarios = list(per.values())
    for row in scenarios:
        row["attack_success_rate"] = _rate(row["successes"], row["attempts"])
    by_category: dict[str, dict[str, int]] = defaultdict(lambda: {"attempts": 0, "successes": 0, "errors": 0})
    for row in scenarios:
        for key in ("attempts", "successes", "errors"):
            by_category[row["category"]][key] += row[key]
    attempts = sum(r["attempts"] for r in scenarios)
    successes = sum(r["successes"] for r in scenarios)
    return {
        "schema_version": SCHEMA_VERSION,
        "pack": {"id": pack.id, "version": pack.version},
        "experiment": experiment,
        "orbit_version": orbit_version,
        "agent": {"name": agent_name, "tools": tools, "tool_aliases": {k: v for k, v in aliases.items() if k != v}},
        "model": model,
        "attack_success_rate": _rate(successes, attempts),
        "attempts": attempts,
        "attack_successes": successes,
        "errors": sum(r["errors"] for r in scenarios),
        "by_category": {
            cat: {**vals, "attack_success_rate": _rate(vals["successes"], vals["attempts"])}
            for cat, vals in sorted(by_category.items())
        },
        "scenarios": scenarios,
    }
