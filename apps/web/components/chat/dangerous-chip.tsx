import { cn } from "../../lib/utils";

/**
 * The chat's "Dangerous" badge (KOBE-476 AC1): the agent is an admin's Dangerous agent, so its
 * allowed tools run without an approval card. Its text says what it means, not its colour.
 */
export function DangerousChip({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span
      title="This agent's allowed tools run without asking for approval (set by an admin)"
      className={cn(
        "text-destructive border-destructive/40 inline-flex shrink-0 items-center rounded-full border px-2.5 text-xs font-medium",
        compact ? "h-6" : "h-7",
      )}
    >
      Dangerous
    </span>
  );
}
