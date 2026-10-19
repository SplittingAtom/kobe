/**
 * The description meter (KOBE-321, spec SK12). Characters are counted as the server counts them
 * (UTF-16 code units, `String.length`). Past 1,024 the Agent Skills format's limit is passed (and
 * Save version refuses it); past 1,536 Claude Code's cap too, so the skill would not travel.
 */
export const DESCRIPTION_SPEC_MAX = 1024;
export const DESCRIPTION_PORTABLE_MAX = 1536;

export type MeterLevel = "ok" | "over_spec" | "over_portable";

export interface DescriptionMeter {
  readonly length: number;
  readonly level: MeterLevel;
  readonly message: string | null;
}

export function descriptionMeter(description: string): DescriptionMeter {
  const length = description.length;
  if (length > DESCRIPTION_PORTABLE_MAX)
    return {
      length,
      level: "over_portable",
      message:
        "Past 1,536 characters: Claude Code cuts it off too, and Save version refuses anything past 1,024.",
    };
  if (length > DESCRIPTION_SPEC_MAX)
    return {
      length,
      level: "over_spec",
      message: "Past 1,024 characters, the Agent Skills limit: Save version refuses it.",
    };
  return { length, level: "ok", message: null };
}
