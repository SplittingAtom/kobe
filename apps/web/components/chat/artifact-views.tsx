"use client";

/**
 * Renderers of one artifact version (KOBE-130, D-7). Text kinds (markdown, code, csv) open in the
 * file editor's UI, read-only (`artifact-text-view.tsx`, KOBE-485): Rendered uses the chat's
 * Markdown component (no raw HTML, no images) and CSV tables of text cells; Mermaid renders with
 * `securityLevel: "strict"` and is shown as an image (inert: no script, no network, and the page
 * CSP's `style-src` doesn't apply to it); HTML and SVG load in an iframe from the server's frame
 * route (own CSP, opaque origin). The iframe never gets `allow-same-origin` and never uses `srcdoc`
 * (a `srcdoc` document would inherit the page CSP, which blocks inline scripts).
 */
import { useEffect, useId, useRef, useState } from "react";
import {
  ARTIFACT_FRAME_SANDBOX,
  artifactFrameUrl,
  fenced,
  isArtifactTextKind,
  isFrameKind,
  type ArtifactDetailView,
} from "../../lib/chat/artifacts";
import type { ApiError } from "../../lib/api/client";
import { ErrorNotice } from "../admin/error-notice";
import type { TextMode } from "../files/text-modes";
import { ArtifactTextView } from "./artifact-text-view";
import { useChatSession } from "./kobe-runtime";
import { Markdown } from "./markdown";

type Content =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly text: string };

function useArtifactContent(id: string, version: number, enabled: boolean): Content {
  const session = useChatSession();
  const [state, setState] = useState<Content>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setState({ status: "loading" });
    void session.api.artifactContent(id, version).then((res) => {
      if (!current) return;
      setState(
        res.ok ? { status: "ready", text: res.data.text } : { status: "error", error: res.error },
      );
    });
    return () => {
      current = false;
    };
  }, [session, id, version, enabled]);
  return state;
}

/** Mermaid, loaded on demand (it is large); `strict` stops it from running anything in a diagram. */
function MermaidView({ text, title }: { readonly text: string; readonly title: string }) {
  const base = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "error" }
    | { readonly status: "ready"; readonly src: string }
  >({ status: "loading" });
  const runs = useRef(0);
  useEffect(() => {
    let current = true;
    runs.current += 1;
    const id = `${base}r${runs.current}`; // fresh per run: mermaid keeps elements by id
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          flowchart: { htmlLabels: false },
        });
        const { svg } = await mermaid.render(id, text);
        if (current) {
          setState({
            status: "ready",
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          });
        }
      } catch {
        // mermaid.render leaves its scratch element in <body> when it fails.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (current) setState({ status: "error" });
      }
    })();
    return () => {
      current = false;
    };
  }, [base, text]);
  if (state.status === "loading") return <p role="status">Rendering the diagram…</p>;
  if (state.status === "error") {
    return (
      <>
        <p role="alert">This diagram could not be rendered. Its source:</p>
        <Markdown text={fenced(text, "mermaid")} />
      </>
    );
  }
  return <img src={state.src} alt={`Diagram: ${title}`} className="max-w-full" />;
}

export function ArtifactBody({
  artifact,
  version,
  mode,
  onMode,
  canEdit,
}: {
  readonly artifact: ArtifactDetailView;
  readonly version: number;
  /** Text kinds (KOBE-485): Rendered or Raw, kept by the tab across versions. */
  readonly mode: TextMode;
  onMode(mode: TextMode): void;
  /** The viewer owns the thread: text kinds offer Edit as file. */
  readonly canEdit: boolean;
}) {
  const session = useChatSession();
  const framed = isFrameKind(artifact.kind);
  const content = useArtifactContent(artifact.id, version, !framed);
  if (framed) {
    return (
      <iframe
        title={`${artifact.title} (version ${version})`}
        src={artifactFrameUrl(artifact.id, version, session.teamId)}
        sandbox={ARTIFACT_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="bg-white h-full min-h-80 w-full rounded-md border"
      />
    );
  }
  if (content.status === "loading") return <p role="status">Loading the content…</p>;
  if (content.status === "error") return <ErrorNotice error={content.error} />;
  if (isArtifactTextKind(artifact.kind)) {
    return (
      <ArtifactTextView
        artifact={artifact}
        version={version}
        text={content.text}
        canEdit={canEdit}
        mode={mode}
        onMode={onMode}
      />
    );
  }
  switch (artifact.kind) {
    case "mermaid":
      return <MermaidView text={content.text} title={artifact.title} />;
    default:
      return <Markdown text={fenced(content.text, null)} />;
  }
}
