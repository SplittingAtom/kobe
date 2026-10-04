"""Entry point: kobe-orbit-eval --orbit-yaml agent.yaml [--pack pack.yaml] [--output result.json]."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

# Before inspect_ai is imported: no dotenv credential loading, no telemetry-style surprises.
os.environ.setdefault("PYTHON_DOTENV_DISABLED", "1")

from .scenarios import DEFAULT_PACK, PackError, load_pack
from .settings import Settings, SettingsError, load_settings

EXIT_USAGE = 2
EXIT_RUN = 3


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="kobe-orbit-eval", description=__doc__)
    p.add_argument("--orbit-yaml", type=Path, required=True, help="exported Orbit YAML (KOBE-90/91)")
    p.add_argument("--pack", type=Path, default=DEFAULT_PACK, help="scenario pack (default: built in)")
    p.add_argument("--output", type=Path, help="write the JSON result here (always also printed to stdout)")
    p.add_argument("--epochs", type=int, default=1, help="repeats per scenario (default 1)")
    p.add_argument("--validate-only", action="store_true", help="load and validate inputs, make no model calls")
    args = p.parse_args(argv)
    if not 1 <= args.epochs <= 10:
        p.error("--epochs must be between 1 and 10")
    return args


def _load_agent(path: Path):
    from orbit.wrapper.yaml_loader import load_experiment_config

    config = load_experiment_config(path)
    if len(config.setup.agents) != 1:
        raise PackError(f"expected exactly one agent in {path}, found {len(config.setup.agents)}")
    return config, config.setup.agents[0]


def _model_id(settings: Settings, agent) -> str:
    model = settings.model_override or agent.model
    if not model:
        raise SettingsError("no model: the export has none (alias dropped) and KOBE_EVAL_MODEL is unset")
    return model


def _write_output(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as tmp:
        tmp.write(text)
    os.replace(tmp.name, path)


def run(args: argparse.Namespace) -> dict | None:
    from importlib.metadata import version

    from inspect_ai import eval as inspect_eval

    from .report import build_report
    from .task import build_task
    from .tools import alias_tool_names, reserved_tool_names

    pack = load_pack(args.pack)
    config, agent = _load_agent(args.orbit_yaml)
    aliases = alias_tool_names(agent.tools, reserved_tool_names())
    if args.validate_only:
        print(f"ok: {len(pack.scenarios)} scenarios, agent {agent.name!r} with {len(agent.tools)} tools", file=sys.stderr)
        return None
    settings = load_settings()
    model_id = _model_id(settings, agent)
    os.environ.update(settings.inspect_env())
    with tempfile.TemporaryDirectory(prefix="kobe-orbit-logs-") as log_dir:
        [log] = inspect_eval(
            build_task(pack, agent, aliases, args.epochs),
            model=settings.inspect_model(model_id),
            log_dir=log_dir,
            display="none",
            log_realtime=False,
            max_retries=2,
            retry_on_error=0,
            fail_on_error=False,
        )
        if log.status == "error" and not log.samples:
            raise RuntimeError(f"evaluation failed: {log.error.message if log.error else 'unknown error'}")
        return build_report(
            log, pack,
            agent_name=agent.name, tools=list(agent.tools), aliases=aliases,
            model=model_id, orbit_version=version("orbit"), experiment=config.name,
        )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = run(args)
    except (PackError, SettingsError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except ValueError as exc:  # Orbit's loader rejects an invalid export
        print(f"error: invalid input: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except Exception as exc:  # noqa: BLE001 - the Job must report, not hang or trace secrets
        print(f"error: evaluation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_RUN
    if report is None:
        return 0
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        _write_output(args.output, text)
    sys.stdout.write(text)
    return 1 if report["errors"] else 0
