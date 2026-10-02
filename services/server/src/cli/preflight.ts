import { writeFileSync } from "node:fs";
import { listRuntimeClasses } from "../isolation/kubernetes.js";
import { checkIsolation } from "../isolation/runtime-class.js";
import { logger } from "../logger.js";

// Helm pre-install/pre-upgrade hook: fail the release when no isolation RuntimeClass exists.
const TERMINATION_LOG = "/dev/termination-log";

const result = await checkIsolation(listRuntimeClasses);
if (result.ok) {
  logger.info({ runtimeClasses: result.runtimeClasses }, "isolation preflight passed");
} else {
  logger.error(result.message);
  try {
    // Surfaces the remediation in `kubectl describe` / the Job's pod status.
    writeFileSync(TERMINATION_LOG, result.message);
  } catch {
    // Not running in Kubernetes; the log line above is enough.
  }
  process.exitCode = 1;
}
