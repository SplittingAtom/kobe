import { writeFileSync } from "node:fs";
import { listRuntimeClasses } from "../isolation/kubernetes.js";
import { checkIsolation } from "../isolation/runtime-class.js";
import { logger } from "../logger.js";

// Isolation gate, run as the Helm pre-install/pre-upgrade/pre-rollback hook and as an initContainer
// of the server and scheduler: fails unless KOBE_RUNTIME_CLASS (the class sandboxes use) exists
// and has a gVisor or Kata handler.
const TERMINATION_LOG = "/dev/termination-log";

const runtimeClassName = process.env.KOBE_RUNTIME_CLASS?.trim();
const result = runtimeClassName
  ? await checkIsolation(listRuntimeClasses, runtimeClassName)
  : {
      ok: false as const,
      message: "KOBE_RUNTIME_CLASS is not set; refusing to start without isolation.",
    };
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
