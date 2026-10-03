import { types } from "node:util";
import { MAX_INPUT_DEPTH } from "./protocol.js";

/**
 * Tool inputs as kobe-policy decides them. Pi hands `tool_call` handlers the object the tool will
 * execute with (verified Pi 1.0.0: after `prepareArguments` and schema validation, same reference),
 * so the extension checks that object, not a copy, and makes sure the check means something:
 *
 * - **plain JSON only** ({@link findPlainJsonIssue}): what the server sees (`JSON.stringify`) must
 *   be exactly what the tool reads. Getters, proxies, non-enumerable or symbol keys, exotic
 *   prototypes, `undefined`, non-finite numbers, holes and shared references are refused, because
 *   each can make the serialised view differ from what the tool reads;
 * - **frozen before asking** ({@link deepFreeze}): nothing (an earlier handler's timer, a
 *   `tool_execution_start` handler) can change the input between the decision and execution.
 *   Verified: Pi 1.0.0 built-ins (read, write, edit, bash, ls, grep, find, codemode) run with a
 *   deep-frozen input;
 * - **fingerprinted** ({@link stableJson}): the same input after the decision, or the call is
 *   blocked.
 */
export function findPlainJsonIssue(root: unknown): string | undefined {
  if (!isPlainObject(root)) return "tool input is not a plain JSON object";
  const seen = new Set<object>();
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    const primitive = primitiveIssue(value);
    if (primitive !== null) {
      if (primitive !== undefined) return primitive;
      continue;
    }
    if (depth > MAX_INPUT_DEPTH) return "tool input is nested too deeply";
    const container = value as object;
    if (seen.has(container)) return "tool input repeats an object reference";
    seen.add(container);
    const children = childrenOf(container);
    if (typeof children === "string") return children;
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return undefined;
}

/** `null` = a container to descend into; `undefined` = a fine primitive; string = the issue. */
function primitiveIssue(value: unknown): string | undefined | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "tool input has a non-finite number";
    // JSON.stringify(-0) is "0": the server would decide a different value than the tool reads.
    return Object.is(value, -0) ? "tool input has a negative zero" : undefined;
  }
  if (typeof value === "object") return null;
  return `tool input has a ${typeof value} value`;
}

function childrenOf(container: object): unknown[] | string {
  if (types.isProxy(container)) return "tool input contains a proxy";
  if (Array.isArray(container)) return arrayChildren(container);
  if (!isPlainObject(container)) return "tool input contains a non-plain object";
  const values: unknown[] = [];
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key !== "string") return "tool input has a symbol key";
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    const issue = descriptorIssue(descriptor);
    if (issue !== undefined) return issue;
    values.push(descriptor?.value);
  }
  return values;
}

function arrayChildren(array: unknown[]): unknown[] | string {
  if (Object.getPrototypeOf(array) !== Array.prototype) return "tool input has an exotic array";
  const values: unknown[] = [];
  for (const key of Reflect.ownKeys(array)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
      return "tool input array has extra properties";
    }
  }
  for (let index = 0; index < array.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, index);
    if (descriptor === undefined) return "tool input array has holes";
    const issue = descriptorIssue(descriptor);
    if (issue !== undefined) return issue;
    values.push(descriptor.value);
  }
  return values;
}

function descriptorIssue(descriptor: PropertyDescriptor | undefined): string | undefined {
  if (descriptor === undefined || !("value" in descriptor)) return "tool input has an accessor";
  if (descriptor.enumerable !== true) return "tool input has a hidden property";
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (types.isProxy(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Freeze a value checked by {@link findPlainJsonIssue} (no cycles, no accessors), all the way down:
 * an already (shallowly) frozen container is still descended into.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    Object.freeze(current);
    for (const key of Object.keys(current)) stack.push((current as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Deterministic JSON (object keys sorted by UTF-16 code units, like RFC 8785) for comparing an input
 * with itself before and after a decision. Not a wire format.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
