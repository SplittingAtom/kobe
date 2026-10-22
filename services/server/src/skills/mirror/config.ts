import { z } from "zod";
import type { SandboxSettings } from "../../sandbox/config.js";
import type { MirrorAuthor } from "./git-mirror.js";

/**
 * The git mirror's deployment configuration (KOBE-343, SK29). The Site admin turns the mirror on
 * and names the remote in the console (a Registry setting); the credentials and identity come from
 * the chart: the token from a Kubernetes Secret (`skills.mirror.tokenSecret`), never the database,
 * a URL or a log. Unset token: the mirror can't push and the console says so.
 */
const schema = z.object({
  KOBE_SKILL_MIRROR_TOKEN: z
    .string()
    .default("")
    .refine((v) => v === "" || (v.length >= 8 && v.length <= 4096 && !/[\s:]/.test(v)), {
      message: "KOBE_SKILL_MIRROR_TOKEN must be 8-4096 characters without spaces or colons",
    }),
  // GitHub accepts any user name with a token; GitHub App tokens need x-access-token. Forgejo
  // takes the token's owner (or any name, depending on version).
  KOBE_SKILL_MIRROR_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, "KOBE_SKILL_MIRROR_USERNAME must be a plain user name")
    .default("x-access-token"),
  KOBE_SKILL_MIRROR_AUTHOR_NAME: z.string().trim().min(1).max(100).default("Kobe Registry"),
  KOBE_SKILL_MIRROR_AUTHOR_EMAIL: z.email().max(200).default("registry@kobe.invalid"),
});

export interface SkillMirrorConfig {
  readonly credentials: { readonly username: string; readonly token: string } | null;
  readonly author: MirrorAuthor;
}

export function loadSkillMirrorConfig(
  env: Readonly<Record<string, string | undefined>>,
): SkillMirrorConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    credentials:
      e.KOBE_SKILL_MIRROR_TOKEN === ""
        ? null
        : { username: e.KOBE_SKILL_MIRROR_USERNAME, token: e.KOBE_SKILL_MIRROR_TOKEN },
    author: { name: e.KOBE_SKILL_MIRROR_AUTHOR_NAME, email: e.KOBE_SKILL_MIRROR_AUTHOR_EMAIL },
  };
}

/** The egress proxy's in-cluster address, from the endpoints the chart gives the server. */
export function egressProxyUrl(settings: SandboxSettings): string {
  const e = settings.endpoints.egressProxy;
  return `http://${e.service}.${settings.releaseNamespace}.svc:${e.port}`;
}
