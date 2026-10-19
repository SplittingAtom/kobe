/**
 * At most {@link MAX_LIVE_FRAMES} live app frames per thread (KOBE-438, spec MA10, T13). A card
 * near the viewport asks for a slot; when all are taken it waits behind "Show app", and a click
 * takes the slot of the frame least recently in view. Pure: every function returns a new list
 * (least recent first).
 */
export const MAX_LIVE_FRAMES = 3;

/** `key` gets a slot: kept (moved to most recent), added, or (forced) taking the oldest one. */
export function takeSlot(
  live: readonly string[],
  key: string,
  force: boolean,
  max = MAX_LIVE_FRAMES,
): readonly string[] {
  if (live.includes(key))
    return live.at(-1) === key ? live : [...live.filter((k) => k !== key), key];
  if (live.length < max) return [...live, key];
  return force ? [...live.slice(live.length - max + 1), key] : live;
}

export function releaseSlot(live: readonly string[], key: string): readonly string[] {
  return live.includes(key) ? live.filter((k) => k !== key) : live;
}
