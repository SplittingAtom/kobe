import { Badge } from "../../../ui/console";

/** The agent is in the admin-only Dangerous approval mode (KOBE-476 AC1): shown wherever it is. */
export function DangerousBadge() {
  return (
    <Badge tone="failed" title="Its allowed tools run without asking for approval">
      Dangerous
    </Badge>
  );
}
