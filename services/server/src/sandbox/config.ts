import { SESSION_TOKEN_AUDIENCES, type SessionTokenAudience } from "@kobe/protocol";
import { z } from "zod";
import { KOBE_ENDPOINTS, type KobeEndpoint } from "./constants.js";

/**
 * Sandbox provider configuration (spec D11, D12). The chart renders it into KOBE_SANDBOX_CONFIG
 * (JSON, from the `sandbox` values) and the per-audience session-token keys into
 * KOBE_SESSION_KEY_* (from the generated Secret). Validated at startup; invalid config fails fast.
 */

const quantity = z
  .string()
  .regex(/^\d+(\.\d+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/, "must be a Kubernetes quantity (e.g. 500m, 4Gi)");
const dnsLabel = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "must be a DNS label");
const dnsName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "must be a DNS subdomain name");
const labelMap = z.record(
  z.string().max(253),
  z
    .string()
    .max(63)
    .regex(/^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/),
);
const port = z.number().int().min(1).max(65535);

const endpointSchema = z.strictObject({
  /** Service in the release namespace. */
  service: dnsLabel,
  /** Service port the sandbox connects to. */
  port,
  /** Pod port behind it (NetworkPolicy rules match pods, after Service DNAT). */
  targetPort: port,
  /** Labels selecting the backing pods. */
  podLabels: labelMap.refine((m) => Object.keys(m).length > 0, "must select pods"),
});

const resourcesSchema = z.strictObject({
  requests: z.strictObject({ cpu: quantity, memory: quantity }),
  limits: z.strictObject({ cpu: quantity, memory: quantity }),
});

export const sandboxSettingsSchema = z.strictObject({
  image: z.string().min(1).max(512),
  imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]),
  /** Copied into team namespaces for the kubelet; never mounted into sandboxes. */
  imagePullSecrets: z.array(dnsName).max(8),
  releaseNamespace: dnsLabel,
  /** The server's ServiceAccount (bound to managerClusterRole in each team namespace). */
  serverServiceAccount: dnsName,
  managerClusterRole: dnsName,
  endpoints: z.strictObject(
    Object.fromEntries(KOBE_ENDPOINTS.map((e) => [e, endpointSchema])) as Record<
      KobeEndpoint,
      typeof endpointSchema
    >,
  ),
  resources: resourcesSchema,
  /** Container ephemeral storage (logs, writable layers, /tmp and $HOME emptyDirs). */
  ephemeralStorage: z.strictObject({ request: quantity, limit: quantity }),
  /**
   * Whether sandboxes may reach the model gateway. Off until the gateway verifies session tokens
   * (KOBE-40/41): until then, reachable Bifrost would let any agent spend model credit.
   */
  modelGatewayAccess: z.boolean(),
  workspace: z.strictObject({ size: quantity, storageClass: z.string().max(253) }),
  tmpSize: quantity,
  homeSize: quantity,
  teamQuota: z.record(z.string().regex(/^[a-z][a-z.-]*$/), quantity),
  warmPool: z.strictObject({ replicasPerTeam: z.number().int().min(0).max(20) }),
});
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

/** KOBE_SESSION_KEY_<AUDIENCE>: one HMAC key per audience (≥ 32 chars). */
export const sessionKeyEnvName = (audience: SessionTokenAudience): string =>
  `KOBE_SESSION_KEY_${audience
    .replace(/^kobe\./, "")
    .replace(/-/g, "_")
    .toUpperCase()}`;

export type SessionKeys = Readonly<Record<SessionTokenAudience, string>>;

export interface SandboxConfig {
  readonly settings: SandboxSettings;
  readonly sessionKeys: SessionKeys;
}

const MIN_KEY_LENGTH = 32;

/**
 * Returns undefined when KOBE_SANDBOX_CONFIG is unset (the sandbox provider stays disabled and
 * agent work fails with a clear error); throws when it is set but invalid or keys are missing.
 */
export function loadSandboxConfig(
  env: Readonly<Record<string, string | undefined>>,
): SandboxConfig | undefined {
  const raw = env.KOBE_SANDBOX_CONFIG?.trim();
  if (!raw) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Invalid configuration: KOBE_SANDBOX_CONFIG is not valid JSON");
  }
  const parsed = sandboxSettingsSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: KOBE_SANDBOX_CONFIG ${issues}`);
  }
  const keys: Partial<Record<SessionTokenAudience, string>> = {};
  const problems: string[] = [];
  for (const audience of SESSION_TOKEN_AUDIENCES) {
    const name = sessionKeyEnvName(audience);
    const value = env[name];
    // Never echo the value: these are signing keys.
    if (!value || value.length < MIN_KEY_LENGTH) {
      problems.push(`${name} must be at least ${MIN_KEY_LENGTH} characters`);
    } else {
      keys[audience] = value;
    }
  }
  const distinct = new Set(Object.values(keys));
  if (problems.length === 0 && distinct.size !== SESSION_TOKEN_AUDIENCES.length) {
    problems.push("KOBE_SESSION_KEY_* must all differ (one key per audience)");
  }
  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  return { settings: parsed.data, sessionKeys: keys as SessionKeys };
}
