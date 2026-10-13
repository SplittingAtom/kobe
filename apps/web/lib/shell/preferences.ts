/**
 * Layout preferences per user (CE8, KOBE-202): the rail's collapsed state, the Threads/Files
 * divider and the artifact column's width follow the member across devices. The shell loads them
 * once at start (`GET /v1/me/preferences`) and applies them to the rail and the artifact column;
 * changes are debounced into one `PUT` of the keys that changed (callers commit on release or
 * toggle, never per pointer move). A failure is logged and never blocks the UI: the shell keeps
 * its defaults and whatever the member does on screen.
 *
 * Applying checks each value against this screen: a stored value that no longer fits (a width the
 * space can't hold next to the conversation's floor, a share outside the rail's bounds) is ignored
 * and the default applies.
 *
 * Narrow screens keep their default (the rail starts collapsed, CE8; A5 KOBE-201 owns the
 * breakpoints): a stored "expanded" never opens the rail on a phone, and the rail's state changed
 * there is not saved, so closing the drawer on a phone never collapses the rail on a desktop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { THREADS_SHARE_BOUNDS } from "@kobe/protocol";
import { apiRequest } from "../api/client";
import { ARTIFACT_FLOOR_PX, CONVERSATION_FLOOR_PX } from "../chat/artifact-tabs";

export const PREFERENCES_PATH = "/v1/me/preferences";
/** Changes within this window go out as one PUT. */
export const SAVE_DELAY_MS = 600;
/** The rail's width in px (shell.module.css `--kobe-rail-width`). */
export const RAIL_WIDTH_PX = { expanded: 280, collapsed: 48 } as const;

export interface LayoutPreferences {
  readonly railCollapsed?: boolean;
  readonly threadsShare?: number;
  /** null: the default, half the space right of the rail. */
  readonly artifactWidth?: number | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The response's preferences (camel-cased by the API client); anything malformed is dropped. */
export function readPreferences(data: unknown): LayoutPreferences {
  const raw = isRecord(data) && isRecord(data.preferences) ? data.preferences : {};
  const out: Mutable<LayoutPreferences> = {};
  if (typeof raw.railCollapsed === "boolean") out.railCollapsed = raw.railCollapsed;
  if (typeof raw.threadsShare === "number" && Number.isFinite(raw.threadsShare)) {
    out.threadsShare = raw.threadsShare;
  }
  if (raw.artifactWidth === null) out.artifactWidth = null;
  else if (typeof raw.artifactWidth === "number" && Number.isInteger(raw.artifactWidth)) {
    out.artifactWidth = raw.artifactWidth;
  }
  return out;
}

/** The wire body (snake_case) for a change. */
export function toWire(change: LayoutPreferences): Record<string, unknown> {
  return {
    ...(change.railCollapsed !== undefined ? { rail_collapsed: change.railCollapsed } : {}),
    ...(change.threadsShare !== undefined ? { threads_share: change.threadsShare } : {}),
    ...(change.artifactWidth !== undefined ? { artifact_width: change.artifactWidth } : {}),
  };
}

/** The rail's collapsed state to apply, or null to keep the default. Narrow: always collapsed. */
export function applyRailCollapsed(stored: boolean | undefined, narrow: boolean): boolean | null {
  if (narrow) return true;
  return stored ?? null;
}

/** The stored share if it is within the rail's bounds, else null (the default applies). */
export function applyThreadsShare(stored: number | undefined): number | null {
  if (stored === undefined || !Number.isFinite(stored)) return null;
  return stored >= THREADS_SHARE_BOUNDS.min && stored <= THREADS_SHARE_BOUNDS.max ? stored : null;
}

/**
 * The stored width if it fits `available` px (the space right of the rail) beside the
 * conversation's 400 px floor and is at least the column's 360 px floor, else null (the default,
 * half the space).
 */
export function applyArtifactWidth(
  stored: number | null | undefined,
  available: number,
): number | null {
  if (stored === null || stored === undefined || !Number.isFinite(stored)) return null;
  if (stored < ARTIFACT_FLOOR_PX) return null;
  return stored + CONVERSATION_FLOOR_PX <= available ? stored : null;
}

/** The space right of the rail in this window, for {@link applyArtifactWidth}. */
export function availableBesideRail(railCollapsed: boolean): number {
  const viewport = typeof window === "undefined" ? 0 : window.innerWidth;
  return viewport - (railCollapsed ? RAIL_WIDTH_PX.collapsed : RAIL_WIDTH_PX.expanded);
}

type Log = (message: string, detail?: unknown) => void;
const warn: Log = (message, detail) => console.warn(`[kobe] ${message}`, detail ?? "");

/** Reads the caller's preferences; on any failure logs it and returns none (the defaults). */
export async function loadPreferences(
  fetchFn?: typeof fetch,
  log: Log = warn,
): Promise<LayoutPreferences> {
  const res = await apiRequest<unknown>(PREFERENCES_PATH, { fetchFn });
  if (res.ok) return readPreferences(res.data);
  log("layout preferences could not be loaded; using the defaults", res.error);
  return {};
}

export interface PreferencesSaver {
  /** Queues a change; changes within the delay go out as one PUT. */
  save(change: LayoutPreferences): void;
  /** Sends what is queued now (the shell unmounting). */
  flush(): void;
}

/** Debounces changes into one PUT of the keys that changed; failures are logged, never thrown. */
export function createPreferencesSaver({
  fetchFn,
  delayMs = SAVE_DELAY_MS,
  log = warn,
}: {
  readonly fetchFn?: typeof fetch | undefined;
  readonly delayMs?: number;
  readonly log?: Log;
} = {}): PreferencesSaver {
  let pending: LayoutPreferences = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const body = toWire(pending);
    pending = {};
    if (Object.keys(body).length === 0) return;
    void apiRequest<unknown>(PREFERENCES_PATH, { method: "PUT", json: body, fetchFn }).then(
      (res) => {
        if (!res.ok) log("layout preferences could not be saved", res.error);
      },
    );
  };
  return {
    save(change) {
      pending = { ...pending, ...change };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}

export interface LayoutPreferencesApi {
  /** What the member stored; null until loaded (`{}` when loading failed: the defaults). */
  readonly preferences: LayoutPreferences | null;
  save(change: LayoutPreferences): void;
}

/** Loads the preferences once when the shell starts and saves changes, debounced. */
export function useLayoutPreferences(fetchFn?: typeof fetch): LayoutPreferencesApi {
  const [preferences, setPreferences] = useState<LayoutPreferences | null>(null);
  const saver = useRef<PreferencesSaver | null>(null);
  const fetchRef = useRef(fetchFn);
  useEffect(() => {
    let current = true;
    void loadPreferences(fetchRef.current).then((p) => {
      if (current) setPreferences(p);
    });
    const own = createPreferencesSaver({ fetchFn: fetchRef.current });
    saver.current = own;
    return () => {
      current = false;
      own.flush();
      if (saver.current === own) saver.current = null;
    };
  }, []);
  const save = useCallback((change: LayoutPreferences) => saver.current?.save(change), []);
  return useMemo(() => ({ preferences, save }), [preferences, save]);
}
