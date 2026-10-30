"use client";

/**
 * What an open text tab does when its file changed outside it (KOBE-491, KOBE-496). Changes are
 * heard two ways: the tab's `VersionWatch` checks on hints (this thread's live write or run end,
 * window focus), and the page's change stream (`lib/files/remote-changes.ts`) says who changed
 * which file, live and again after every reconnect.
 *
 * - With a draft nothing is replaced: the tab is `changed` (the editor's banner: Compare, Keep
 *   mine, Take theirs). Keep mine dismisses that version's banner; once the draft is gone (saved,
 *   discarded, Take theirs) a waiting change is read in, or offered when it was someone else's.
 * - Without a draft, only this thread's own agent reloads the tab silently (`updated`): the version
 *   must be one this tab's own check found on that agent's live write or run-end hint. A stream
 *   change by the agent that arrives while such a check is running waits for it; if the check ends
 *   without finding that version, it is offered. Anything else (another tab or device, the agent
 *   of another thread or a schedule, project files, a change found on focus) is `remote`: the badge
 *   with Reload; nothing is replaced until the member reloads.
 * A file gone from the workspace closes a clean tab (the read says so); a draft keeps it open.
 * A file moved (the stream names `moved_to`, KOBE-516) is not read here: its tab follows it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceChangeActor, WorkspaceFileChange } from "@kobe/protocol";
import type { FilesApi } from "../../lib/files/api";
import type { EditDraftStore } from "../../lib/files/editor-state";
import { fileVersion, VersionWatch, type HintSource } from "../../lib/files/outside-change";
import type { ChangeHint } from "../chat/use-file-change-hint";
import { useDraft } from "./file-editor";

/** Who changed the file and when, as the change stream said (absent: not known). */
export interface ChangedBy {
  readonly actor: WorkspaceChangeActor | null;
  readonly at: string | null;
}

export type OutsideChange =
  /** Read in place: the tab now shows this thread's agent's version `sha256`. */
  | { readonly kind: "updated"; readonly sha256: string }
  /** The member has a draft: version `sha256` is waiting, nothing was replaced. */
  | {
      readonly kind: "changed";
      readonly sha256: string;
      readonly by?: ChangedBy | undefined;
      /** This thread's own agent: once the draft is gone it is read in without asking. */
      readonly own?: boolean | undefined;
    }
  /** No draft, someone else's change: the badge offers Reload; nothing was replaced. */
  | { readonly kind: "remote"; readonly sha256: string; readonly by?: ChangedBy | undefined };

export interface OutsideChangeOptions {
  readonly api: FilesApi;
  readonly path: string;
  /** The version the tab shows (undefined: not a checkable text file). */
  readonly known: string | undefined;
  readonly hint: ChangeHint | null | undefined;
  readonly drafts: EditDraftStore | undefined;
  /** The latest change the page's stream heard for this path (KOBE-496). */
  readonly remote?: WorkspaceFileChange | undefined;
  reread(): void;
}

export function useOutsideChange(options: OutsideChangeOptions) {
  const { api, path, known, hint, drafts, remote, reread } = options;
  const [outside, setOutside] = useState<OutsideChange | null>(null);
  const knownRef = useRef(known);
  knownRef.current = known;
  const dismissed = useRef<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const rereadRef = useRef(reread);
  rereadRef.current = reread;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const pathRef = useRef(path);
  pathRef.current = path;
  /** Versions this tab's own check found on this thread's agent's hints. */
  const ownVersions = useRef(new Set<string>());
  /** A stream change by the agent waiting for this thread's running check to claim it. */
  const waiting = useRef<string | null>(null);

  /** A new version `sha256` is in the workspace: read it in, offer it, or wait behind the draft. */
  const decideRef = useRef((sha256: string, source: HintSource | "stream") => {
    const latest = remoteRef.current;
    const by = latest?.sha256 === sha256 ? { actor: latest.actor, at: latest.at } : undefined;
    const kind = by?.actor?.kind;
    // This thread's agent: its own check found this version, and the stream (if it said) agrees.
    if (source === "agent" && (kind === undefined || kind === "agent")) {
      ownVersions.current.add(sha256);
    }
    if (waiting.current === sha256) waiting.current = null;
    const own = ownVersions.current.has(sha256) && (kind === undefined || kind === "agent");
    if (draftsRef.current?.get(pathRef.current) !== undefined) {
      if (dismissed.current !== sha256) {
        setOutside((o) => sameChange(o, { kind: "changed", sha256, by, own }));
      }
    } else if (own) {
      setOutside((o) => sameChange(o, { kind: "updated", sha256 }));
      rereadRef.current();
    } else {
      setOutside((o) => sameChange(o, { kind: "remote", sha256, by }));
    }
  });

  const [watch, setWatch] = useState<VersionWatch | null>(null);
  const watchRef = useRef(watch);
  watchRef.current = watch;
  useEffect(() => {
    const next = new VersionWatch({
      check: (signal) => fileVersion(api, path, signal),
      known: () => knownRef.current,
      // The check ended without claiming a waiting agent change: it was another agent's.
      onIdle: () => {
        const sha256 = waiting.current;
        waiting.current = null;
        if (sha256 !== null && sha256 !== knownRef.current) decideRef.current(sha256, "stream");
      },
      onChange: (result, source) => {
        if (result.kind === "gone") {
          // The read finds it gone and closes a clean tab; a draft keeps it open.
          if (draftsRef.current?.get(path) === undefined) rereadRef.current();
          return;
        }
        decideRef.current(result.sha256, source);
      },
    });
    setWatch(next);
    return () => next.dispose();
  }, [api, path]);

  useEffect(() => {
    if (hint && watch) watch.hint(hint.delays, { oneShot: hint.oneShot === true });
  }, [hint, watch]);

  // The change stream (KOBE-496): each message once (a reconnect's state is a new message, so a
  // change or deletion made while the stream was down is compared again, whatever its revision).
  const handled = useRef<WorkspaceFileChange | null>(null);
  useEffect(() => {
    if (!remote || known === undefined || handled.current === remote) return;
    handled.current = remote;
    if (remote.sha256 === known) return;
    if (remote.sha256 === null) {
      // Moved (KOBE-516): the panel retargets the tab to the new path; nothing to read here.
      if (remote.moved_to != null) return;
      // Not in the workspace (deleted, or its tombstone already collected): the read closes a
      // clean tab, or reloads it when the stream was wrong; a draft keeps it open.
      if (draftsRef.current?.get(path) === undefined) rereadRef.current();
      return;
    }
    const sha256 = remote.sha256;
    const watcher = watchRef.current;
    if (
      remote.actor?.kind === "agent" &&
      !ownVersions.current.has(sha256) &&
      watcher?.pending === "agent"
    ) {
      waiting.current = sha256; // this thread's running check decides whether it is its agent's
      return;
    }
    watcher?.settle(); // the stream named the newest version: no need to keep checking
    decideRef.current(sha256, "stream");
  }, [remote, known, path]);

  // The draft went away (saved, discarded, Take theirs) while a change waited.
  const draft = useDraft(drafts ?? NO_DRAFTS, path);
  useEffect(() => {
    if (draft !== undefined || outside?.kind !== "changed") return;
    if (known === outside.sha256) setOutside(null);
    else if (outside.own === false) {
      setOutside({ kind: "remote", sha256: outside.sha256, by: outside.by });
    } else {
      setOutside((o) => sameChange(o, { kind: "updated", sha256: outside.sha256 }));
      rereadRef.current();
    }
  }, [draft, outside, known]);

  // The member started typing under the badge: their draft now waits behind that change.
  useEffect(() => {
    if (draft === undefined || outside?.kind !== "remote") return;
    setOutside({ kind: "changed", sha256: outside.sha256, by: outside.by, own: false });
  }, [draft, outside]);

  // Read in by any route (Reload, a re-open, Take theirs): the badge has done its job.
  useEffect(() => {
    if (outside?.kind === "remote" && known === outside.sha256) setOutside(null);
  }, [outside, known]);

  /** Keep mine: this version's banner stays dismissed; Save then names the choice again. */
  const dismiss = useCallback(() => {
    if (outside) dismissed.current = outside.sha256;
    setOutside(null);
  }, [outside]);
  /** The badge's Reload: read the file in place (the editor keeps the cursor where it can). */
  const reload = useCallback(() => {
    setOutside(null);
    rereadRef.current();
  }, []);
  return { outside, dismiss, reload };
}

/** The current state when it already says this (no new object, no re-render). */
function sameChange(current: OutsideChange | null, next: OutsideChange): OutsideChange {
  if (current?.kind !== next.kind || current.sha256 !== next.sha256) return next;
  if (next.kind === "updated") return current;
  const a = (current as { by?: ChangedBy }).by;
  const b = next.by;
  return a?.actor?.kind === b?.actor?.kind && a?.at === b?.at ? current : next;
}

const NO_DRAFTS = {
  subscribe: () => () => {},
  get: () => undefined,
} as unknown as EditDraftStore;
