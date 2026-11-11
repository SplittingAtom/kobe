"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { copyText } from "../../lib/clipboard";
import { Button } from "../ui/button";

/**
 * A path on this site with a button that copies its full URL (KOBE-616: /llms.txt). The link opens
 * a new tab: the Docs panel and the workspace under it stay as they were.
 */
export function CopyUrl({ path }: { readonly path: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await copyText(new URL(path, window.location.href).href);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <a href={path} target="_blank" rel="noopener">
        <code>{path}</code>
      </a>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={copy}
        aria-label={`Copy the ${path} URL`}
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </Button>
      {failed && (
        <span role="status" className="text-muted-foreground text-xs">
          Copy failed: select the link instead.
        </span>
      )}
    </span>
  );
}
