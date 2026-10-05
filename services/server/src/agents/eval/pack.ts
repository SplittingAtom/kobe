/**
 * The scenario pack the eval image runs by default (images/orbit-eval/scenarios/default-pack.yaml)
 * and how many scenario runs a complete result has. A result for another pack, or one that did not
 * run every scenario, is not trusted (KOBE-93). `pack.test.ts` keeps this equal to the YAML.
 */
export const EXPECTED_PACK = { id: "kobe-default", version: 1, scenarios: 5 } as const;
/** The image's default `--epochs`. */
export const EVAL_EPOCHS = 1;
