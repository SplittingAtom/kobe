import { readFile } from "node:fs/promises";
import { MODEL_FILE_ENV, parseModelFile, type ModelFileState } from "./protocol.js";

/**
 * The model file's location, taken from the environment once and removed from it: tools Pi
 * spawns inherit Pi's environment and have no business knowing where the token is (they run as
 * Pi's uid and could read the file anyway, KOBE-71; this keeps it out of every child's `env`).
 */
export function takeModelFilePath(env: Record<string, string | undefined>): string | undefined {
  const value = env[MODEL_FILE_ENV];
  Reflect.deleteProperty(env, MODEL_FILE_ENV);
  if (value === undefined || !value.startsWith("/")) return undefined;
  return value;
}

/** Read and validate the model file as it is right now (the agent rewrites it atomically). */
export async function readModelState(file: string): Promise<ModelFileState> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read the model file: ${(error as Error).message}`, { cause: error });
  }
  return parseModelFile(text);
}
