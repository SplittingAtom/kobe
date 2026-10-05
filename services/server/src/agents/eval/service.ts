import { randomBytes } from "node:crypto";
import { teams, type KobeDb } from "@kobe/db";
import type { AgentDefinition } from "@kobe/agent-file";
import { signSessionToken } from "@kobe/session-token";
import { IsolationRuntimeMissingError, type IsolationGate } from "../../isolation/gate.js";
import { logger } from "../../logger.js";
import type { SandboxSettings, SessionKeys } from "../../sandbox/config.js";
import { LABEL_ORBIT_EVAL } from "../../sandbox/constants.js";
import { KubeApiError, type KubeClient, type ObjectRef } from "../../sandbox/kube.js";
import { teamNamespaceName, type KubeObject, type TeamRef } from "../../sandbox/manifests.js";
import type { SandboxProvider } from "../../sandbox/provider.js";
import type { VersionLimits } from "../versions.js";
import { publishEvaluated } from "../versions.js";
import {
  EVAL_CONTAINER,
  EVAL_TOKEN_GRACE_SECONDS,
  evalConfigMapManifest,
  evalJobManifest,
  evalJobName,
} from "./job.js";
import { judge, type JobOutcome, type Verdict } from "./judge.js";
import {
  finishEval,
  getEval,
  markRunning,
  recordPublication,
  staleEvals,
  type EvalRecord,
} from "./store.js";

/**
 * Runs Orbit evals as Kubernetes Jobs (KOBE-93). One driver per eval creates the ConfigMap and the
 * Job, waits for the Job to end, reads the result from the pod's log and records the verdict. A
 * passed eval then publishes the evaluated snapshot. Every failure along the way ends the eval as
 * `errored` (fail closed: nothing is published, the person may retry). A sweeper finishes evals
 * whose driver died with the server (it collects the Job's result if the Job finished meanwhile).
 */

const LOG_LIMIT_BYTES = 1024 * 1024;
const POLL_MS = 3_000;
/** The driver gives up this long after the Job's own deadline (image pull and scheduling lag). */
const DRIVER_SLACK_SECONDS = 120;
/** The sweeper takes over an unfinished eval this long after the driver would have given up. */
const SWEEP_SLACK_SECONDS = 120;
const MAX_ERROR = 500;

export interface EvalRunnerOptions {
  readonly db: KobeDb;
  readonly kube: KubeClient;
  readonly provider: Pick<SandboxProvider, "ensureTeam">;
  readonly isolation: Pick<IsolationGate, "require">;
  readonly settings: SandboxSettings;
  readonly sessionKeys: SessionKeys;
  readonly limits?: VersionLimits;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface EvalRun {
  readonly record: EvalRecord;
  readonly team: TeamRef;
  /** The exported Orbit YAML of the evaluated draft. */
  readonly orbitYaml: string;
}

const ref = (kind: string, name: string, namespace: string, apiVersion = "v1"): ObjectRef => ({
  apiVersion,
  kind,
  name,
  namespace,
});

const field = (obj: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (cur, key) =>
      typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[key] : undefined,
    obj,
  );

/** Where a Job ended, from its conditions; undefined while it is still running. */
export function jobOutcome(job: KubeObject): JobOutcome | undefined {
  const conditions = field(job, "status", "conditions");
  if (!Array.isArray(conditions)) return undefined;
  for (const c of conditions as Record<string, unknown>[]) {
    if (c.status !== "True") continue;
    if (c.type === "Complete") return { kind: "succeeded" };
    if (c.type === "Failed") {
      return { kind: "failed", reason: typeof c.reason === "string" ? c.reason : "Failed" };
    }
  }
  return undefined;
}

export class EvalRunner {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;

  constructor(private readonly options: EvalRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  /** Whether the install configured the eval image; without it an enabled gate blocks publishing. */
  get available(): boolean {
    const { settings } = this.options;
    return settings.orbitEval !== undefined && settings.modelGatewayAccess;
  }

  /** Drives one eval to a verdict. Never throws: every failure is recorded as `errored`. */
  async run(run: EvalRun): Promise<void> {
    // Minted first so that no error message can carry it (`fail` redacts it).
    const token = this.mintToken(run.record, this.options.settings.orbitEval?.deadlineSeconds ?? 0);
    try {
      await this.start(run, token);
      const outcome = await this.waitForJob(run);
      await this.conclude(run, outcome);
    } catch (err) {
      await this.fail(run, err, token);
    }
  }

  /** Finishes evals nobody is driving any more (the server restarted mid-eval). */
  async sweep(): Promise<number> {
    const { orbitEval } = this.options.settings;
    if (!orbitEval) return 0;
    const before = new Date(
      this.now().getTime() -
        (orbitEval.deadlineSeconds + DRIVER_SLACK_SECONDS + SWEEP_SLACK_SECONDS) * 1000,
    );
    const all = await this.options.db.select({ id: teams.id, slug: teams.slug }).from(teams);
    let finished = 0;
    for (const team of all) {
      for (const record of await staleEvals(this.options.db, team.id, before)) {
        try {
          await this.adopt({ record, team });
          finished++;
        } catch (err) {
          logger.error({ err, evalId: record.id }, "orbit eval sweep failed");
        }
      }
    }
    return finished;
  }

  /** Collects a Job that finished while no driver watched, or errors the eval (timed out). */
  private async adopt(run: Omit<EvalRun, "orbitYaml">): Promise<void> {
    const namespace = teamNamespaceName(run.team);
    const job = await this.options.kube.get(
      ref("Job", evalJobName(run.record.id), namespace, "batch/v1"),
    );
    const outcome = job ? jobOutcome(job) : undefined;
    if (!outcome) {
      await this.deleteJob(namespace, run.record.id);
      await finishEval(this.options.db, run.team.id, run.record.id, {
        status: "errored",
        error: "The eval did not finish in time or was interrupted. Nothing was published.",
      });
      return;
    }
    await this.conclude({ ...run, orbitYaml: "" }, outcome);
  }

  /** Creates the inputs and the Job. */
  private async start(run: EvalRun, token: string): Promise<void> {
    const { options } = this;
    const { orbitEval } = options.settings;
    if (!orbitEval || !options.settings.modelGatewayAccess) {
      throw new Error("Orbit evals are not configured for this install (the eval image is unset).");
    }
    const { record, team } = run;
    const verified = await options.isolation.require();
    const namespace = await options.provider.ensureTeam(team, verified);
    const gateway = options.settings.endpoints.modelGateway;
    const svc = await options.kube.get(
      ref("Service", gateway.service, options.settings.releaseNamespace),
    );
    const address = field(svc, "spec", "clusterIP");
    if (typeof address !== "string" || address === "") {
      throw new Error("The model gateway Service has no ClusterIP.");
    }
    const common = { namespace, teamId: team.id, evalId: record.id };
    await options.kube.apply(evalConfigMapManifest({ ...common, orbitYaml: run.orbitYaml }));
    // Running before the Job exists: the gateway accepts the eval's token only while it is running.
    if (!(await markRunning(options.db, team.id, record.id, evalJobName(record.id)))) {
      throw new Error("The eval was finished by someone else before its Job started.");
    }
    const job = await options.kube.create(
      evalJobManifest({
        ...common,
        isolation: verified,
        sandbox: options.settings,
        eval: orbitEval,
        gatewayAddress: address,
        model: record.model,
        token,
      }),
    );
    // The Job owns its ConfigMap: both go when the Job's TTL expires.
    const uid = job.metadata.uid;
    if (uid) {
      await options.kube.patch(ref("ConfigMap", evalJobName(record.id), namespace), {
        metadata: {
          ownerReferences: [
            { apiVersion: "batch/v1", kind: "Job", name: evalJobName(record.id), uid },
          ],
        },
      });
    }
  }

  /** Short-lived, team- and eval-scoped: the only credential the Job holds. Never a provider key. */
  private mintToken(record: EvalRecord, deadlineSeconds: number): string {
    const iat = Math.floor(this.now().getTime() / 1000);
    return signSessionToken(
      {
        iss: "kobe-server",
        aud: "kobe.model-gateway",
        sub: record.id,
        team_id: record.teamId,
        user_id: record.requestedBy,
        iat,
        exp: iat + deadlineSeconds + EVAL_TOKEN_GRACE_SECONDS,
        jti: randomBytes(18).toString("base64url"),
      },
      this.options.sessionKeys["kobe.model-gateway"],
    );
  }

  private async waitForJob(run: EvalRun): Promise<JobOutcome> {
    const { kube, settings } = this.options;
    const namespace = teamNamespaceName(run.team);
    const deadline =
      this.now().getTime() +
      ((settings.orbitEval?.deadlineSeconds ?? 0) + DRIVER_SLACK_SECONDS) * 1000;
    const jobRef = ref("Job", evalJobName(run.record.id), namespace, "batch/v1");
    for (;;) {
      const outcome = jobOutcome(
        (await kube.get(jobRef)) ?? { apiVersion: "", kind: "", metadata: { name: "" } },
      );
      if (outcome) return outcome;
      if (this.now().getTime() >= deadline) {
        await this.deleteJob(namespace, run.record.id);
        return { kind: "failed", reason: "timed out" };
      }
      await this.sleep(this.pollMs);
    }
  }

  private async readLog(team: TeamRef, evalId: string): Promise<string> {
    const { kube } = this.options;
    const namespace = teamNamespaceName(team);
    const pods = await kube.list("v1", "Pod", namespace, `${LABEL_ORBIT_EVAL}=${evalId}`);
    const pod = pods[0];
    if (!pod) return "";
    return (
      (await kube.logs(ref("Pod", pod.metadata.name, namespace), {
        container: EVAL_CONTAINER,
        limitBytes: LOG_LIMIT_BYTES,
      })) ?? ""
    );
  }

  /** Reads the result, records the verdict and, for a pass, publishes the evaluated snapshot. */
  private async conclude(run: EvalRun, outcome: JobOutcome): Promise<void> {
    const { record, team } = run;
    const log = await this.readLog(team, record.id);
    const verdict: Verdict = judge({ outcome, log, threshold: record.threshold });
    const finished = await finishEval(this.options.db, team.id, record.id, verdict);
    if (finished?.status === "passed") await this.publish(finished);
  }

  private async publish(passed: EvalRecord): Promise<void> {
    const { db, limits } = this.options;
    const location =
      passed.agentScope === "team"
        ? ({ scope: "team", teamId: passed.teamId } as const)
        : ({ scope: "personal", ownerUserId: passed.requestedBy } as const);
    const result = await publishEvaluated(db, location, passed.agentId, {
      definition: passed.definition as unknown as AgentDefinition,
      draftRevision: passed.draftRevision,
      publishedBy: passed.requestedBy,
      ...(limits ? { limits } : {}),
    });
    await recordPublication(
      db,
      passed.teamId,
      passed.id,
      result.ok
        ? { version: result.value.version.version }
        : { note: `Passed, but not published: ${PUBLISH_FAILURES[result.error]}` },
    );
  }

  private async fail(run: EvalRun, err: unknown, token: string): Promise<void> {
    const raw =
      err instanceof IsolationRuntimeMissingError
        ? "The isolation runtime (gVisor or Kata) could not be verified."
        : err instanceof KubeApiError || err instanceof Error
          ? err.message
          : "unknown error";
    const message = (token ? raw.replaceAll(token, "[redacted]") : raw).slice(0, MAX_ERROR);
    logger.error({ err, evalId: run.record.id }, "orbit eval failed");
    try {
      await this.deleteJob(teamNamespaceName(run.team), run.record.id);
    } catch {
      // The Job's TTL collects it; the verdict below matters more.
    }
    const current = await getEval(this.options.db, run.team.id, run.record.id);
    if (current && (current.status === "pending" || current.status === "running")) {
      await finishEval(this.options.db, run.team.id, run.record.id, {
        status: "errored",
        error: `${message} Nothing was published.`,
      });
    }
  }

  private async deleteJob(namespace: string, evalId: string): Promise<void> {
    await this.options.kube.delete(ref("Job", evalJobName(evalId), namespace, "batch/v1"));
    await this.options.kube.delete(ref("ConfigMap", evalJobName(evalId), namespace));
  }
}

const PUBLISH_FAILURES = {
  not_found: "the agent no longer exists.",
  revision_mismatch: "the draft changed.",
  archived: "the agent is archived.",
  version_not_found: "no such version.",
  already_current: "that version is already current.",
  invalid_draft: "the draft is no longer valid.",
  unchanged: "it equals the current version.",
  version_limit: "the agent is at its version limit.",
} as const;
