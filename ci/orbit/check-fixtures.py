"""KOBE-90: load the Orbit export mapper's fixtures with Orbit's real YAML loader.

Run in an environment with the pinned Orbit (see ci/orbit/README in the ci.yml job). Fails when
Orbit rejects a fixture, or when the loader stops rejecting unknown keys (the loader would then
prove nothing about the mapper's output).
"""

import sys
from pathlib import Path

import yaml
from orbit.wrapper.yaml_loader import load_experiment_config

FIXTURES = Path(__file__).resolve().parents[2] / "services/server/src/agents/orbit/fixtures"


def main() -> int:
    paths = sorted(FIXTURES.glob("*.yaml"))
    if not paths:
        print(f"no fixtures in {FIXTURES}", file=sys.stderr)
        return 1
    for path in paths:
        config = load_experiment_config(path)
        raw = yaml.safe_load(path.read_text())
        agent = config.setup.agents[0]
        expected = raw["setup"]["agents"][0]
        assert agent.tools == expected["tools"], f"{path.name}: tools changed in load"
        assert agent.system_prompt == expected["system_prompt"], f"{path.name}: prompt changed"
        print(f"ok {path.name}: {config.name} ({len(agent.tools)} tools)")

    bad = paths[0].read_text() + "unexpected_key: 1\n"
    probe = FIXTURES.parent / ".probe-unknown-key.yaml"
    probe.write_text(bad)
    try:
        load_experiment_config(probe)
    except ValueError:
        print("ok loader rejects unknown keys")
        return 0
    finally:
        probe.unlink()
    print("loader accepted an unknown key: it is not validating", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
