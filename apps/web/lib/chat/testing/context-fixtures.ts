import type { ContextSection, ThreadContext } from "@kobe/protocol";

/** A context viewer section (KOBE-471), wire casing. */
export const section = (
  kind: ContextSection["kind"],
  tokens: number,
  text = "x",
  label = "",
): ContextSection => ({ kind, label, text, tokens, chars: text.length, truncated: false });

/** A `GET /v1/threads/{id}/context` 200 body with these sections, a 1000-token window. */
export const contextOf = (
  sections: ContextSection[],
  extra: Partial<ThreadContext> = {},
): ThreadContext => ({
  thread_id: "00000000-0000-4000-8000-000000000001",
  source: "model_call",
  exact: true,
  missing: [],
  captured_at: "2026-10-21T10:00:00.000Z",
  model: "ollama/kimi",
  context_window: 1000,
  total_tokens: sections.reduce((n, s) => n + s.tokens, 0),
  tokens_basis: "usage",
  sections,
  truncated: false,
  omitted_sections: 0,
  ...extra,
});
