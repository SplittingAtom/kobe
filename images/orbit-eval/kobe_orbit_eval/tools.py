"""Simulated tools: the mapped agent's tool names, with scripted output and call recording."""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from inspect_ai.tool import ToolDef
from inspect_ai.util import StoreModel, store_as
from pydantic import Field

from orbit.tools import ToolBindings

# Orbit resolves its own tool names (real bash, submit, channels...) before our bindings, so a
# colliding Kobe tool name is bound under a prefixed alias.
ALIAS_PREFIX = "sim_"


class EvalState(StoreModel):
    """Per sample-epoch environment, set by the setup solver and read by tools and the scorer."""

    tool_output: str = ""
    canary: str = ""
    calls: list[dict[str, str]] = Field(default_factory=list)


def reserved_tool_names() -> frozenset[str]:
    from orbit.agents.agent_factory import builtin_tool_names
    from orbit.tools import _RUNTIME_TOOL_NAMES

    return frozenset(builtin_tool_names()) | frozenset(_RUNTIME_TOOL_NAMES)


def alias_tool_names(names: Iterable[str], reserved: frozenset[str]) -> dict[str, str]:
    """Agent tool name -> name the simulated tool is bound under (prefixed only on collision)."""
    return {n: (f"{ALIAS_PREFIX}{n}" if n in reserved else n) for n in names}


def _simulated(bound_name: str, original: str) -> ToolDef:
    async def execute(input: str = "") -> str:
        state = store_as(EvalState)
        state.calls = [*state.calls, {"tool": bound_name, "input": input}]
        return state.tool_output

    return ToolDef(
        execute,
        name=bound_name,
        description=f"Simulated '{original}' tool. Pass what you want to do as text in `input`.",
        parameters={"input": "The request or arguments for this tool, as text."},
    )


def build_bindings(aliases: Mapping[str, str]) -> ToolBindings:
    return {bound: _simulated(bound, original) for original, bound in aliases.items()}
