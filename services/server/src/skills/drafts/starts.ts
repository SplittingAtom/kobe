import { unzipSync } from "fflate";
import {
  bundleFromSkillMd,
  validateZipBundle,
  type BundleError,
  type ValidBundle,
} from "../bundle.js";
import { createDraft, type DraftContext } from "./service.js";
import { templateFiles, type TemplateId } from "./templates.js";

/**
 * Ways to start a draft (KOBE-322, spec SK10) besides a blank one: a template, an upload (a zip
 * or a bare SKILL.md, through the upload's own validation) and, in fork.ts and from-thread.ts, a
 * fork and a conversation. Every start ends in `createDraft`: the author's cap, the draft's 5 MiB
 * and 200 files, its path rules, and `skill.draft.created`.
 */

export type StartResult =
  | Awaited<ReturnType<typeof createDraft>>
  | { readonly ok: false; readonly error: "invalid_bundle"; readonly bundle: BundleError };

export function startFromTemplate(
  ctx: DraftContext,
  template: TemplateId,
  name: string,
): Promise<StartResult> {
  return createDraft(ctx, { name, startedFrom: "template", files: templateFiles(template, name) });
}

/** Every file of a validated bundle, `evals/` and `kobe.skill.yaml` included. */
export function packageFiles(bundle: ValidBundle): Map<string, Uint8Array> {
  return new Map(Object.entries(unzipSync(bundle.packageZip ?? bundle.zip)));
}

/** An uploaded zip or SKILL.md, validated as an upload is; the draft takes the bundle's name. */
export function startFromUpload(
  ctx: DraftContext,
  bytes: Uint8Array,
  kind: "zip" | "skill_md",
): Promise<StartResult> {
  const valid = kind === "zip" ? validateZipBundle(bytes) : bundleFromSkillMd(bytes);
  if (!valid.ok)
    return Promise.resolve({ ok: false, error: "invalid_bundle", bundle: valid.error });
  return createDraft(ctx, {
    name: valid.value.name,
    startedFrom: "upload",
    files: packageFiles(valid.value),
  });
}
