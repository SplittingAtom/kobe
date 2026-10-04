"""Builds the Inspect task: the mapped agent, run by Orbit, once per scenario."""

from __future__ import annotations

from inspect_ai import Epochs, Task
from inspect_ai.dataset import Sample
from orbit import SchedulerConfig, SetupConfig, multi_agent_task
from orbit.configs import AgentSpec, ExecutionConfig

from .scenarios import Pack
from .scoring import attack_success, prepare_environment
from .tools import build_bindings

MAX_TURNS = 1
TIME_LIMIT_SECONDS = 120
TOKEN_LIMIT = 40_000


def eval_agent(agent: AgentSpec, aliases: dict[str, str]) -> AgentSpec:
    """The exported agent, run through the gateway model with simulated tools.

    model is cleared so Orbit uses the task model (the gateway); submit is off (no terminal tool to rely on; one
    activation runs the agent's tool loop until its first tool-free reply, see build_task); tools are renamed only where Orbit reserves the name.
    """
    return agent.model_copy(
        update={
            "model": None,
            "tools": [aliases[name] for name in agent.tools],
            "submit": False,
            "temperature": 0.0,
        }
    )


def build_task(pack: Pack, agent: AgentSpec, aliases: dict[str, str], epochs: int) -> Task:
    samples = [
        Sample(
            id=s.id,
            input=s.user_prompt,
            target=s.canary,
            metadata={"category": s.category, "tool_output": s.tool_output, "canary": s.canary},
        )
        for s in pack.scenarios
    ]
    return multi_agent_task(
        name=f"kobe-orbit-{pack.id}",
        setup=SetupConfig(agents=[eval_agent(agent, aliases)]),
        dataset=samples,
        # One agent, one activation: under the legacy quantum an activation runs the agent's tool
        # loop to its first tool-free reply, and max_turns=1 stops it being re-activated (each
        # extra activation would be another real model call). Per-run bounds: token_limit below.
        execution=ExecutionConfig(executor="scheduled", quantum="legacy"),
        scheduler=SchedulerConfig(
            max_turns=MAX_TURNS,
            max_time_seconds=TIME_LIMIT_SECONDS,
            halt_on_convergence=False,
            health_checks=False,
        ),
        scorer=attack_success(),
        tool_bindings=build_bindings(aliases),
        task_setup=prepare_environment(),
        epochs=Epochs(epochs, "mean"),
        token_limit=TOKEN_LIMIT,
        fail_on_error=False,
    )
