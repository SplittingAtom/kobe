"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Composer dictation with the browser's speech recognition (Web Speech API). The browser does the
 * transcription (Chrome and Edge send the audio to their vendor's service), so Kobe's server never
 * sees audio. Spoken text is appended to the prompt as typed when dictation started.
 */
interface RecognitionResultList {
  readonly length: number;
  readonly [index: number]: {
    readonly length: number;
    readonly [alt: number]: { readonly transcript: string };
  };
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { readonly results: RecognitionResultList }) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

/** Errors worth telling the user about; others (`no-speech`, `aborted`) just end dictation. */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-allowed": "Microphone access is blocked. Allow it in your browser to dictate.",
  "service-not-allowed": "Microphone access is blocked. Allow it in your browser to dictate.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs a network connection.",
};

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as Record<string, RecognitionCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const noSubscribe = () => () => {};

/** Joins the typed prompt and the spoken text with one space. */
export function appendSpoken(typed: string, spoken: string): string {
  const said = spoken.trim();
  if (said === "") return typed;
  if (typed.trim() === "") return said;
  return `${typed.trimEnd()} ${said}`;
}

function transcriptOf(results: RecognitionResultList): string {
  let text = "";
  for (let i = 0; i < results.length; i++) text += results[i]?.[0]?.transcript ?? "";
  return text;
}

export interface Dictation {
  /** False on the server and in browsers without speech recognition. */
  readonly supported: boolean;
  readonly listening: boolean;
  readonly error: string | null;
  /** Starts listening; `typed` is the prompt so far, which spoken text is appended to. */
  readonly start: (typed: string) => void;
  readonly stop: () => void;
}

export function useDictation(setText: (text: string) => void): Dictation {
  const supported = useSyncExternalStore(
    noSubscribe,
    () => recognitionCtor() !== undefined,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Recognition | null>(null);
  const setTextRef = useRef(setText);
  setTextRef.current = setText;

  const stop = useCallback(() => active.current?.stop(), []);

  const start = useCallback((typed: string) => {
    const Ctor = recognitionCtor();
    if (!Ctor || active.current) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language;
    recognition.onresult = (e) => setTextRef.current(appendSpoken(typed, transcriptOf(e.results)));
    recognition.onerror = (e) => setError(ERROR_MESSAGES[e.error] ?? null);
    recognition.onend = () => {
      active.current = null;
      setListening(false);
    };
    setError(null);
    try {
      recognition.start();
    } catch (err) {
      console.error("speech recognition failed to start", err);
      setError("Dictation could not start.");
      return;
    }
    active.current = recognition;
    setListening(true);
  }, []);

  useEffect(() => () => active.current?.abort(), []);

  return { supported, listening, error, start, stop };
}
