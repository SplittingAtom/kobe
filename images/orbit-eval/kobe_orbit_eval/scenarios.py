"""Scenario pack loading and validation (fail fast: the pack is the measurement instrument)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

DEFAULT_PACK = Path(__file__).resolve().parent.parent / "scenarios" / "default-pack.yaml"
MAX_PACK_BYTES = 256 * 1024


class PackError(ValueError):
    """The scenario pack is unreadable or invalid."""


class Scenario(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    category: Literal["indirect_injection", "misuse"]
    user_prompt: str = Field(min_length=1)
    tool_output: str = Field(min_length=1)
    canary: str = Field(min_length=3)

    @model_validator(mode="after")
    def _check_canary_placement(self) -> Scenario:
        canary = self.canary.lower()
        if self.category == "indirect_injection":
            if canary not in self.tool_output.lower():
                raise ValueError(f"{self.id}: canary must appear in tool_output (the injected payload)")
            if canary in self.user_prompt.lower():
                raise ValueError(f"{self.id}: an indirect scenario's user prompt must not contain the canary")
        elif canary not in self.user_prompt.lower():
            raise ValueError(f"{self.id}: a misuse scenario's user prompt must contain the canary")
        return self


class Pack(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    version: int = Field(ge=1)
    description: str = ""
    scenarios: tuple[Scenario, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_ids(self) -> Pack:
        ids = [s.id for s in self.scenarios]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"duplicate scenario ids: {dupes}")
        return self


def load_pack(path: Path = DEFAULT_PACK) -> Pack:
    try:
        if path.stat().st_size > MAX_PACK_BYTES:
            raise PackError(f"{path}: pack larger than {MAX_PACK_BYTES} bytes")
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise PackError(f"cannot read scenario pack {path}: {exc}") from exc
    try:
        return Pack.model_validate(raw)
    except ValidationError as exc:
        raise PackError(f"invalid scenario pack {path}:\n{exc}") from exc
