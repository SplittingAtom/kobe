"""Runtime settings from the environment. Model access is only ever the Kobe model gateway."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

# Inspect's generic OpenAI-compatible provider reads <SERVICE>_BASE_URL / <SERVICE>_API_KEY.
INSPECT_SERVICE = "kobe"


class SettingsError(ValueError):
    """Invalid or missing configuration (the caller exits non-zero with this message)."""


@dataclass(frozen=True)
class Settings:
    gateway_url: str
    session_token: str
    model_override: str | None

    @property
    def base_url(self) -> str:
        return f"{self.gateway_url.rstrip('/')}/v1"

    def inspect_model(self, model_id: str) -> str:
        return f"openai-api/{INSPECT_SERVICE}/{model_id}"

    def inspect_env(self) -> dict[str, str]:
        prefix = INSPECT_SERVICE.upper()
        return {f"{prefix}_BASE_URL": self.base_url, f"{prefix}_API_KEY": self.session_token}


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    source = os.environ if env is None else env
    url = source.get("KOBE_MODEL_GATEWAY_URL", "").strip()
    token = source.get("KOBE_MODEL_SESSION_TOKEN", "").strip()
    if not url.startswith(("http://", "https://")):
        raise SettingsError("KOBE_MODEL_GATEWAY_URL must be an http(s) URL (the Kobe model gateway)")
    if not token:
        raise SettingsError("KOBE_MODEL_SESSION_TOKEN is required (a gateway session token)")
    override = source.get("KOBE_EVAL_MODEL", "").strip() or None
    return Settings(gateway_url=url, session_token=token, model_override=override)
