import type { KobeEventPayload } from "@kobe/protocol";
import styles from "./chat.module.css";

type Item = KobeEventPayload<"context.omitted">["items"][number];

const KIND_LABEL: Readonly<Record<Item["kind"], string>> = {
  skill: "Skill",
  connector: "Connector",
  model: "Model",
};

const REASON_TEXT: Readonly<Record<Item["reason"], string>> = {
  agent_exclusive: "this agent uses only its own skills",
  team_disabled: "your team turned off personal skills",
  blocklisted: "it is blocked by your install",
  shadowed_by_agent: "the agent has its own skill with this name",
  not_team_enabled: "it is not enabled for your team",
  not_user_connected: "you have not connected it yet",
  no_team_default: "your team has no default model",
  not_approved: "it is not approved for your team",
};

const FALLBACK_REASON_TEXT = "it was left out of this run";

/** One sentence for an omitted item, e.g. "Connector github: you have not connected it yet". */
export function omissionText(item: Item): string {
  return `${KIND_LABEL[item.kind]} ${item.name}: ${(REASON_TEXT as Readonly<Record<string, string | undefined>>)[item.reason] ?? FALLBACK_REASON_TEXT}`;
}

/**
 * KOBE-77: what the run-start resolver left out of this run (an agent's connector that is not
 * connected or enabled, a blocked or shadowed skill), so a missing capability is never silent.
 * Names are the agent's own or the member's own items; the server never sends another team's.
 */
export function OmissionNotice({
  payload,
}: {
  readonly payload: KobeEventPayload<"context.omitted">;
}) {
  return (
    <div className={styles.notice} role="note">
      <p>Some of the agent&apos;s tools were left out of this run:</p>
      <ul className="text-muted-foreground list-disc pl-5">
        {payload.items.map((item) => (
          <li key={`${item.kind}:${item.name}:${item.reason}`}>{omissionText(item)}</li>
        ))}
      </ul>
    </div>
  );
}
