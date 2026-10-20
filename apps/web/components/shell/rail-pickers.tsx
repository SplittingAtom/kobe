"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { isPicker, type RailApp } from "../../lib/apps/app-cards";
import type { ToolCallAnswer } from "../../lib/apps/host-bridge";
import { AppFrame } from "../apps/app-frame";
import { useAppComposer } from "../apps/use-app-composer";
import { useThreadSettled } from "../chat/thread-on-screen";
import { OpenedPicker } from "./rail-picker-opening";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import type { RailApi } from "./rail-state";
import styles from "./rail.module.css";

export { PICKER_RAIL_PX } from "../../lib/shell/rail-width";

/**
 * The Apps tab's Pickers section (KOBE-460, spec MA3 as amended 2026-10-20): a dropdown of the
 * member's live apps whose name contains "Picker" (any case), with None; the member's choice is
 * kept per member (`rail_picker`, server-side). The chosen picker runs live here, the one picker
 * frame there is, in the cards' frame (`AppFrame`: the member frame route, its header CSP and
 * sandbox, the same host bridge), laid out like the Files tree: it fills the section and scrolls
 * inside it.
 *
 * It has no card and no thread of its own. Its `ui/message` fills the draft of the conversation
 * on screen (or the new-conversation draft) and never sends; its context is a chip there; its
 * calls name the thread on screen, which the server checks like a card's thread (readable, the
 * connector not off there). It opens with its opening tool's result, called for it when shown
 * (`OpenedPicker`), as a card opens with its stored one. Nothing is written to a thread. It runs only while the Apps tab is
 * on screen in an expanded rail; elsewhere the frame is removed and reloads when shown again. A picker that is no longer live
 * (drift, connector off for the team, key gone) falls back to None with a note; one whose
 * connector is off in this conversation says so.
 */
const GONE =
  "Your picker is no longer available: it changed, or its connector or your key is gone.";
const CARD_KEY = "rail-picker";
/** The opening tool's arguments, as a rail launch sends them (MA11). */
const OPENING_INPUT: Record<string, unknown> = Object.freeze({});

const offNote = (app: RailApp) =>
  `${app.connectorName} is off in this conversation. Turn it on from the + menu to use ${app.title}.`;

/** The picker chosen and live, or the reason there is none. */
function useChosenPicker(rail: RailApi, pickers: readonly RailApp[], settled: boolean) {
  const chosen = pickers.find((p) => p.appId === rail.picker) ?? null;
  const [gone, setGone] = useState(false);
  const { picker, setPicker } = rail;
  // Only a list read successfully says the picker is gone (a failed read shows no apps).
  const lost = settled && picker !== null && chosen === null;
  useEffect(() => {
    if (!lost) return;
    setGone(true);
    setPicker(null);
  }, [lost, setPicker]);
  return { chosen, gone, clearGone: () => setGone(false) };
}

/** Whether the picker's connector is off for the draft or thread on screen. */
function useConnectorOff(app: RailApp | null, threadId: string | null) {
  const session = useChatSession();
  const draftOff = useSyncExternalStore(
    session.draftConnectors.subscribe,
    session.draftConnectors.snapshot,
    session.draftConnectors.snapshot,
  );
  // A thread's off set lives on the server: a refused call tells (and a later answer clears it).
  const [offIn, setOffIn] = useState<string | null>(null);
  const off =
    app !== null &&
    (threadId === null ? draftOff.has(app.connectorId) : offIn === `${threadId}:${app.appId}`);
  // Keyed by the thread the call was sent for, not the one on screen when it answers (LOW-3).
  const onCall = (answer: ToolCallAnswer, calledFor: string | null) => {
    if (calledFor === null || app === null) return;
    const key = `${calledFor}:${app.appId}`;
    if (!answer.ok && answer.code === "connector_off") setOffIn(key);
    else if (offIn === key) setOffIn(null);
  };
  return { off, onCall };
}

function LivePicker({
  app,
  visible,
  threadId,
  onUnavailable,
}: {
  readonly app: RailApp;
  readonly visible: boolean;
  readonly threadId: string | null;
  onUnavailable(): void;
}) {
  const session = useChatSession();
  // A thread being opened is first shown as a new conversation: the opening waits for it.
  const threadReady = useThreadSettled(threadId);
  const composer = useAppComposer(
    {
      appId: app.appId,
      connectorId: app.connectorId,
      templateSha256: app.sha256,
      title: app.title,
    },
    { newConversation: true, active: visible },
  );
  const { off, onCall } = useConnectorOff(app, threadId);
  const answered = (answer: ToolCallAnswer, calledFor: string | null) => {
    onCall(answer, calledFor);
    if (!answer.ok && answer.code === "app_not_available") onUnavailable();
  };
  if (off && threadId === null) {
    return <p className={styles.pickerNote}>{offNote(app)}</p>;
  }
  return (
    <>
      {off && (
        <p role="status" className={styles.pickerNote}>
          {offNote(app)}
        </p>
      )}
      <OpenedPicker
        app={app}
        teamId={session.teamId}
        threadId={threadId}
        ready={threadReady}
        onAnswer={answered}
      >
        {(result) => (
          <AppFrame
            app={app}
            teamId={session.teamId}
            cardKey={CARD_KEY}
            placement="rail"
            threadId={threadId}
            toolInput={OPENING_INPUT}
            toolResult={result}
            onCall={answered}
            onMessage={composer.onMessage}
            onModelContext={composer.onModelContext}
            onDisplayMode={() => "inline"}
          />
        )}
      </OpenedPicker>
    </>
  );
}

export function RailPickers({
  rail,
  apps,
  settled,
  visible,
  onUnavailable,
}: {
  readonly rail: RailApi;
  readonly apps: readonly RailApp[];
  /** The apps list was read (not a failed read): a stored picker missing from it is gone. */
  readonly settled: boolean;
  /** The Apps tab is on screen in an expanded rail. */
  readonly visible: boolean;
  /** A call found the app no longer live: the apps list is read again. */
  onUnavailable(): void;
}) {
  const pickers = apps.filter(isPicker);
  const { chosen, gone, clearGone } = useChosenPicker(rail, pickers, settled);
  const threadId = useKobeExtras()?.state.threadId ?? null;
  const selectId = useId();
  const { setPickerShown } = rail;
  const shown = chosen !== null && visible;
  useEffect(() => {
    setPickerShown(shown);
  }, [shown, setPickerShown]);
  useEffect(() => () => setPickerShown(false), [setPickerShown]);
  if (pickers.length === 0) return null;
  return (
    <div className={styles.pickers} data-kobe-rail-picker={chosen?.appId ?? ""}>
      <div className={styles.sectionHeader}>
        <label htmlFor={selectId} className={styles.sectionTitle}>
          Pickers
        </label>
      </div>
      <div className={styles.pickerControl}>
        <select
          id={selectId}
          aria-label="Picker"
          className={styles.pickerSelect}
          value={chosen?.appId ?? ""}
          onChange={(e) => {
            clearGone();
            rail.setPicker(e.target.value === "" ? null : e.target.value);
          }}
        >
          <option value="">None</option>
          {pickers.map((p) => (
            <option key={p.appId} value={p.appId} title={`${p.title} from ${p.connectorName}`}>
              {p.title}
            </option>
          ))}
        </select>
      </div>
      {gone && chosen === null && (
        <p role="status" className={styles.pickerNote}>
          {GONE}
        </p>
      )}
      {/* Only while on screen (review LOW-2): on the Files tab or in a collapsed rail the frame
          is removed (it gets ui/resource-teardown), so a hidden picker calls nothing. */}
      {shown && (
        <LivePicker
          key={chosen.appId}
          app={chosen}
          visible={visible}
          threadId={threadId}
          onUnavailable={onUnavailable}
        />
      )}
    </div>
  );
}
