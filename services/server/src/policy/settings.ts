import type { ApprovalMode, RiskClass, ToolDescriptor } from "@kobe/protocol";

/**
 * Install-level policy switches. Stored in `install_settings` (one row per key), so an install
 * Owner/Admin flips them through `PUT /v1/install/policy/settings` — no code change, no redeploy.
 */
export interface PolicySettings {
  /**
   * In `ask-on-write` (and `auto`, which denies what ask-on-write would prompt), whether
   * sandbox-scoped write/destructive built-ins (bash, powershell, write, edit) are prompted for by
   * risk class. Default `false`: D29 — "shell and file tools are bounded by the sandbox and egress
   * policy". Open question for Chris (KOBE-35 ledger); `true` makes them prompt like any write.
   * Deny/ask rules and `ask-all` apply either way.
   */
  readonly promptSandboxWrites: boolean;
}

export const DEFAULT_POLICY_SETTINGS: PolicySettings = { promptSandboxWrites: false };

/** `install_settings.key` for {@link PolicySettings.promptSandboxWrites}. */
export const PROMPT_SANDBOX_WRITES_KEY = "policy.ask_on_write.prompt_sandbox_writes";

/**
 * Risk-class prompting in `ask-on-write` (D29), by where the tool's effects land and its risk.
 * `true` = prompt. `sandbox` rows follow {@link PolicySettings.promptSandboxWrites}. `kobe`-scoped
 * writes (artifacts, shared files, memory) prompt: D23/D24 make project writes approval-gated, and
 * personal `remember` is allowed by a built-in allow rule instead (allow-rules.ts).
 */
export function riskClassPrompts(
  tool: Pick<ToolDescriptor, "risk" | "scope">,
  settings: PolicySettings,
): boolean {
  const table: Readonly<Record<ToolDescriptor["scope"], Readonly<Record<RiskClass, boolean>>>> = {
    sandbox: {
      read: false,
      write: settings.promptSandboxWrites,
      destructive: settings.promptSandboxWrites,
    },
    kobe: { read: false, write: true, destructive: true },
    external: { read: false, write: true, destructive: true },
  };
  return table[tool.scope][tool.risk];
}

/** Modes that never wait for a person: whatever would prompt is denied (D29 `auto`, D32). */
export function modeNeverPrompts(mode: ApprovalMode): boolean {
  return mode === "auto";
}
