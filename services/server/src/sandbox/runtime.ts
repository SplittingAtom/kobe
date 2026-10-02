import type { IsolationGate } from "../isolation/gate.js";
import { loadSandboxConfig, type SessionKeys } from "./config.js";
import { createKubeClient } from "./kube.js";
import { createSandboxProvider, type SandboxProvider } from "./provider.js";

export interface SandboxRuntime {
  readonly provider: SandboxProvider;
  readonly sessionKeys: SessionKeys;
}

/**
 * The sandbox provider wired to the in-cluster API, or undefined when the chart did not configure
 * sandboxes (KOBE_SANDBOX_CONFIG unset). Invalid configuration throws (fail fast at startup).
 */
export function createSandboxRuntime(
  env: Readonly<Record<string, string | undefined>>,
  isolation: Pick<IsolationGate, "require">,
): SandboxRuntime | undefined {
  const config = loadSandboxConfig(env);
  if (!config) return undefined;
  return {
    provider: createSandboxProvider({
      kube: createKubeClient(),
      isolation,
      settings: config.settings,
    }),
    sessionKeys: config.sessionKeys,
  };
}
