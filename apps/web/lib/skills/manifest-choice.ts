/**
 * What a member chooses when Kobe writes a kobe.skill.yaml for them (KOBE-564): the model that
 * drafts it (a team-enabled catalog alias; undefined: the team default) and their license, which
 * is the author's statement and never the model's.
 */
export const MANIFEST_LICENSES = ["Proprietary", "Apache-2.0", "MIT", "BSD-3-Clause"] as const;
export type ManifestLicense = (typeof MANIFEST_LICENSES)[number];

export interface ManifestDraftChoice {
  readonly model?: string | undefined;
  readonly license?: ManifestLicense | undefined;
}

/** The choice as the server takes it (optional keys left out). */
export function manifestChoiceJson(choice: ManifestDraftChoice): Record<string, string> {
  return {
    ...(choice.model === undefined ? {} : { model: choice.model }),
    ...(choice.license === undefined ? {} : { license: choice.license }),
  };
}

/** What both manifest routes answer besides the draft. */
export interface ManifestWritten {
  readonly manifest: { readonly summary: string; readonly tags?: readonly string[] };
  /** The catalog alias that answered. */
  readonly model: string;
  /** `model`: fields from the reply; `seed`: SKILL.md's description alone. */
  readonly source: "model" | "seed";
}

export function manifestWrittenNotice(made: ManifestWritten): string {
  return made.source === "model"
    ? `kobe.skill.yaml written by ${made.model}.`
    : `${made.model} gave no usable answer; kobe.skill.yaml starts from the SKILL.md description.`;
}
