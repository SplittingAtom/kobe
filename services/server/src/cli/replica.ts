import { createDb, type KobeDatabase } from "@kobe/db";
import { createIsolationGate } from "../isolation/gate.js";
import { listRuntimeClasses } from "../isolation/kubernetes.js";
import { createSandboxRuntime, type SandboxRuntime } from "../sandbox/runtime.js";
import { createSandboxLifecycle, type SandboxLifecycle } from "../sandbox-lifecycle/index.js";
import {
  createDbRunContextSource,
  createSandboxWire,
  type SandboxWire,
} from "../sandbox-wire/index.js";

/**
 * An operator tool's view of the install, run inside a server pod (its ServiceAccount and env):
 * the database, the sandbox provider behind the isolation gate, the lifecycle (hibernate/wake)
 * and a router-only sandbox-wire replica (no listener; sandboxes stay connected to the servers).
 */
export interface CliReplica {
  readonly database: KobeDatabase;
  readonly runtime: SandboxRuntime;
  readonly lifecycle: SandboxLifecycle;
  readonly wire: SandboxWire;
  close(): Promise<void>;
}

export function joinAsReplica(
  env: Readonly<Record<string, string | undefined>>,
): CliReplica | string {
  const databaseUrl = env.KOBE_DATABASE_URL;
  if (!databaseUrl) return "KOBE_DATABASE_URL is not set";
  const database = createDb(databaseUrl, { max: 4 });
  const isolation = createIsolationGate({
    runtimeClassName: env.KOBE_RUNTIME_CLASS?.trim() || undefined,
    listRuntimeClasses,
  });
  const runtime = createSandboxRuntime(env, isolation, database.db);
  if (!runtime) {
    void database.close();
    return "KOBE_SANDBOX_CONFIG is not set: sandboxes are disabled";
  }
  const lifecycle = createSandboxLifecycle({
    db: database.db,
    provider: runtime.provider,
    idleMinutes: runtime.settings.hibernation.idleMinutes,
  });
  const wire = createSandboxWire({
    db: database.db,
    databaseUrl,
    runContext: createDbRunContextSource(),
    waker: lifecycle.waker,
    sweep: false,
  });
  return {
    database,
    runtime,
    lifecycle,
    wire,
    async close() {
      await wire.close();
      await database.close();
    },
  };
}

/** Exit with `code` once pending output is flushed (pg pools and sockets may otherwise linger). */
export function exitSoon(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
