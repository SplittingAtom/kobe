/**
 * Layout preferences per user (CE8, KOBE-202): the rail's collapsed state, width (KOBE-305) and
 * panels (KOBE-419), the Threads/Files divider and the artifact column's width follow the member
 * across devices. The shell loads them once at start (`GET /v1/me/preferences`) and applies them
 * to the rail and the artifact column; changes are debounced into one `PUT` of the keys that
 * changed (callers commit on release or toggle, never per pointer move), and what is still queued
 * goes out when the page is hidden or left. A failure is logged and never blocks the UI: the shell
 * keeps its defaults and whatever the member does on screen.
 *
 * Applying checks each value against this screen: a stored value that no longer fits (a width the
 * space right of the rail can't hold beside the conversation's floor, a share outside the rail's
 * bounds) is ignored and the default applies.
 *
 * Narrow windows never rewrite the desktop layout (CE7, KOBE-201, `lib/shell/layout.ts`): the
 * stored rail state is the member's choice for wide windows (below 1100 px the rail is collapsed
 * or a drawer, unsaved), and the artifact width is neither applied nor saved while artifacts open
 * as a sheet.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  readUiPreferences,
  type RailPanels,
  type RailTab,
  type UiPreferences,
} from "@kobe/protocol";
import { apiRequest } from "../api/client";
import { ARTIFACT_FLOOR_PX, CONVERSATION_FLOOR_PX } from "../chat/artifact-tabs";

export const PREFERENCES_PATH = "/v1/me/preferences";
/** Changes within this window go out as one PUT. */
export const SAVE_DELAY_MS = 600;

export interface LayoutPreferences {
  readonly railCollapsed?: boolean;
  /** null: the default, half the space right of the rail. */
  readonly artifactWidth?: number | null;
  /** The Detail toggle (KOBE-208): every reasoning block and tool card open. */
  readonly detailExpanded?: boolean;
  /** The expanded rail's dragged width (KOBE-305); null: the default, 280 px. */
  readonly railWidth?: number | null;
  /**
   * Whether the rail's Files section shows (KOBE-419, KOBE-453): "both" or "files" yes, "threads"
   * no. The Threads share of KOBE-198 is no longer read or written (the threads are a panel); the
   * server still accepts what older clients stored.
   */
  readonly railPanels?: RailPanels;
  /** The rail section's last tab (KOBE-448): Files (the default) or Apps. */
  readonly railTab?: RailTab;
  /** The Workbench editor rail's dragged width (KOBE-459); null: the default. */
  readonly workbenchEditorWidth?: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fromWire = (p: UiPreferences): LayoutPreferences => ({
  ...(p.rail_collapsed !== undefined ? { railCollapsed: p.rail_collapsed } : {}),
  ...(p.artifact_width !== undefined ? { artifactWidth: p.artifact_width } : {}),
  ...(p.detail_expanded !== undefined ? { detailExpanded: p.detail_expanded } : {}),
  ...(p.rail_width !== undefined ? { railWidth: p.rail_width } : {}),
  ...(p.rail_panels !== undefined ? { railPanels: p.rail_panels } : {}),
  ...(p.rail_tab !== undefined ? { railTab: p.rail_tab } : {}),
  ...(p.workbench_editor_width !== undefined
    ? { workbenchEditorWidth: p.workbench_editor_width }
    : {}),
});

/** The wire body (snake_case) for a change. */
export function toWire(change: LayoutPreferences): UiPreferences {
  return {
    ...(change.railCollapsed !== undefined ? { rail_collapsed: change.railCollapsed } : {}),
    ...(change.artifactWidth !== undefined ? { artifact_width: change.artifactWidth } : {}),
    ...(change.detailExpanded !== undefined ? { detail_expanded: change.detailExpanded } : {}),
    ...(change.railWidth !== undefined ? { rail_width: change.railWidth } : {}),
    ...(change.railPanels !== undefined ? { rail_panels: change.railPanels } : {}),
    ...(change.railTab !== undefined ? { rail_tab: change.railTab } : {}),
    ...(change.workbenchEditorWidth !== undefined
      ? { workbench_editor_width: change.workbenchEditorWidth }
      : {}),
  };
}

/**
 * The response's preferences, read with the protocol's reader (malformed values dropped). The API
 * client camel-cases responses, so the known keys go back to wire casing first.
 */
export function readPreferences(data: unknown): LayoutPreferences {
  const raw = isRecord(data) && isRecord(data.preferences) ? data.preferences : {};
  return fromWire(
    readUiPreferences({
      rail_collapsed: raw.railCollapsed,
      artifact_width: raw.artifactWidth,
      detail_expanded: raw.detailExpanded,
      rail_width: raw.railWidth,
      rail_panels: raw.railPanels,
      rail_tab: raw.railTab,
      workbench_editor_width: raw.workbenchEditorWidth,
    }),
  );
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

/** Whether `available` px holds both floors (else the column is squeezed: CE7, A5's overlay). */
export function holdsBothFloors(available: number): boolean {
  return available >= ARTIFACT_FLOOR_PX + CONVERSATION_FLOOR_PX;
}

/**
 * The space right of the rail in the shell grid as laid out now: the artifact column and the
 * conversation together (the column is 0 px while empty). null when the grid isn't laid out.
 */
export function spaceRightOfRail(grid: ParentNode | null | undefined): number | null {
  const region = (name: string) =>
    grid?.querySelector<HTMLElement>(`:scope > [data-shell-region="${name}"]`) ?? null;
  const column = region("artifact");
  const conversation = region("conversation");
  if (!column || !conversation) return null;
  const width = column.getBoundingClientRect().width + conversation.getBoundingClientRect().width;
  return width > 0 ? width : null;
}

/** The shell grid on this page (the artifact column's parent), if there is one. */
export function shellGrid(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>('[data-shell-region="artifact"]')?.parentElement ?? null
  );
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
  /** Sends what is queued now; `keepalive` lets it outlive the page (pagehide). */
  flush(options?: { readonly keepalive?: boolean }): void;
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
  const flush = (options: { readonly keepalive?: boolean } = {}) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const body = toWire(pending);
    pending = {};
    if (Object.keys(body).length === 0) return;
    void apiRequest<unknown>(PREFERENCES_PATH, {
      method: "PUT",
      json: body,
      keepalive: options.keepalive,
      fetchFn,
    }).then((res) => {
      if (!res.ok) log("layout preferences could not be saved", res.error);
    });
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

/**
 * Loads the preferences once when the shell starts and saves changes, debounced. What is queued
 * is sent at once (keepalive) when the page is hidden or left, and when the shell unmounts.
 */
export function useLayoutPreferences(
  fetchFn?: typeof fetch,
  /** False until there is a member to load them for (signed in, a team chosen). */
  enabled = true,
): LayoutPreferencesApi {
  const [preferences, setPreferences] = useState<LayoutPreferences | null>(null);
  const saver = useRef<PreferencesSaver | null>(null);
  const fetchRef = useRef(fetchFn);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void loadPreferences(fetchRef.current).then((p) => {
      if (current) setPreferences(p);
    });
    const own = createPreferencesSaver({ fetchFn: fetchRef.current });
    saver.current = own;
    const leave = () => own.flush({ keepalive: true });
    const hidden = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      current = false;
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      own.flush();
      if (saver.current === own) saver.current = null;
    };
  }, [enabled]);
  const save = useCallback((change: LayoutPreferences) => saver.current?.save(change), []);
  return useMemo(() => ({ preferences, save }), [preferences, save]);
}

/**
 * The shell's preferences for pages inside it (KOBE-459: the Workbench editor rail's width): the
 * console and My area pages open as panels beside the workspace, so `ChatApp` provides them to
 * both (one instance: two would load twice and race their debounced PUTs).
 * Outside the shell (tests, a page rendered on its own) it is null: defaults, nothing saved.
 */
export const LayoutPreferencesContext = createContext<LayoutPreferencesApi | null>(null);

export function useShellPreferences(): LayoutPreferencesApi | null {
  return useContext(LayoutPreferencesContext);
}

export interface StoredPreference<T> {
  readonly value: T;
  /** Sets the value on this page only, unsaved (automatic changes, narrow screens). */
  set(next: T): void;
  /** Sets the value and saves it if it changed (a release, a toggle). */
  commit(next: T): void;
  /** The value now, current even before the next render. */
  current(): T;
}

/**
 * One layout value backed by the member's stored preferences: `resolve` runs once, when `ready`,
 * and its non-null answer replaces the value unless the member already changed it on this page.
 */
export function useStoredPreference<T>({
  initial,
  ready,
  resolve,
  save,
}: {
  readonly initial: T;
  readonly ready: boolean;
  /** The stored value that fits now, or null to keep the current one. */
  readonly resolve: () => T | null;
  readonly save: ((value: T) => void) | undefined;
}): StoredPreference<T> {
  const [value, setValue] = useState(initial);
  const latest = useRef(initial);
  const touched = useRef(false);
  const applied = useRef(false);
  const resolveRef = useRef(resolve);
  const saveRef = useRef(save);
  useEffect(() => {
    resolveRef.current = resolve;
    saveRef.current = save;
  });
  useEffect(() => {
    if (!ready || applied.current) return;
    applied.current = true;
    if (touched.current) return;
    const stored = resolveRef.current();
    if (stored === null) return;
    latest.current = stored;
    setValue(stored);
  }, [ready]);
  const set = useCallback((next: T) => {
    touched.current = true;
    latest.current = next;
    setValue(next);
  }, []);
  const commit = useCallback(
    (next: T) => {
      const changed = next !== latest.current;
      set(next);
      if (changed) saveRef.current?.(next);
    },
    [set],
  );
  const current = useCallback(() => latest.current, []);
  return useMemo(() => ({ value, set, commit, current }), [value, set, commit, current]);
}
