"use client";

/**
 * An HTML notebook output (KOBE-465, notebooks NB4), and only that, in the sandboxed artifact
 * frame: the iframe loads the server's fixed shell (`/v1/workspace/output-frame`: the artifact
 * frame's headers, so an opaque origin with no cookies and no network) and, once it has loaded,
 * the page posts the HTML to it. The HTML is never put into the page and never sent as `srcdoc`.
 * It is posted once per frame: a document that navigated itself away never receives it.
 */
import { useRef } from "react";
import { ARTIFACT_FRAME_SANDBOX } from "../../lib/chat/artifacts";
import { OUTPUT_FRAME_MESSAGE, outputFrameUrl } from "../../lib/notebooks/api";

export function OutputFrame({ html, teamId }: { readonly html: string; readonly teamId: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const posted = useRef(false);
  const onLoad = () => {
    if (posted.current) return;
    posted.current = true;
    // The shell has an opaque origin, so no target origin can name it; it takes only its
    // parent's first message.
    frame.current?.contentWindow?.postMessage({ type: OUTPUT_FRAME_MESSAGE, html }, "*");
  };
  return (
    <iframe
      ref={frame}
      title="HTML output"
      src={outputFrameUrl(teamId)}
      sandbox={ARTIFACT_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      data-kobe-output-frame=""
      className="h-80 w-full resize-y rounded-md border bg-white"
    />
  );
}
