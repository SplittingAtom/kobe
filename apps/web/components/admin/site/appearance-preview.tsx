"use client";

import type { SiteBranding, ThemeSettings } from "@kobe/protocol";
import { useSyncExternalStore } from "react";
import { documentCspNonce } from "../../../lib/security/csp-nonce";
import { PREVIEW_IDS, previewCss } from "../../../lib/theme/preview-css";
import { Brand } from "../../shell/brand";
import { BrandingProvider } from "../../shell/branding-context";
import { Badge, Button, Card, TextInput } from "../../ui/console";

/**
 * The live preview (KOBE-501, theming plan §6): a mini shell, light and dark side by side, styled
 * by the real theme CSS (`brandingCss` scoped to each root, lib/theme/preview-css.ts) in a nonced
 * `<style>` (the CSP allows nonced styles only, lib/security/csp.ts). The nonce is read from the
 * document, so the style exists only in the browser; the roots are inert (a picture, not a form).
 */

const noSubscribe = () => () => undefined;

function PreviewStyle({ css }: { readonly css: string }) {
  // null on the server render (no document): the style is added once the page is in the browser.
  const nonce = useSyncExternalStore(
    noSubscribe,
    () => documentCspNonce(),
    () => null,
  );
  if (nonce === null || css === "") return null;
  return (
    <style nonce={nonce === "" ? undefined : nonce} data-kobe-preview="">
      {css}
    </style>
  );
}

function MiniShell({
  scheme,
  branding,
}: {
  readonly scheme: "light" | "dark";
  readonly branding: SiteBranding;
}) {
  return (
    <div
      id={PREVIEW_IDS[scheme]}
      data-theme={scheme}
      inert
      className="box-border flex min-w-0 flex-col gap-3 overflow-hidden rounded-lg border border-console-border bg-console-bg font-sans text-console-fg"
    >
      <div className="flex items-center justify-between gap-2 border-b border-console-border bg-console-panel px-3 py-2">
        <span className="text-lg font-semibold">
          <BrandingProvider value={branding}>
            <Brand />
          </BrandingProvider>
        </span>
        <span className="text-sm text-console-muted">{scheme === "light" ? "Light" : "Dark"}</span>
      </div>
      <div className="flex flex-col gap-3 px-3 pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" tabIndex={-1}>
            Primary action
          </Button>
          <a
            href={`#${PREVIEW_IDS[scheme]}`}
            tabIndex={-1}
            className="text-console-accent underline"
          >
            A link
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="running">Running</Badge>
          <Badge tone="attention">Needs you</Badge>
          <Badge tone="failed">Failed</Badge>
        </div>
        <Card title="A card" level={4}>
          <TextInput
            aria-label={`Sample field (${scheme})`}
            tabIndex={-1}
            defaultValue="Text in a field"
            readOnly
          />
        </Card>
      </div>
    </div>
  );
}

export function AppearancePreview({
  branding,
  theme,
}: {
  /** The draft: the name and the "show the name" choice as typed, the files as saved. */
  readonly branding: SiteBranding;
  /** The draft style; the saved one while the draft is not a valid theme. */
  readonly theme: ThemeSettings;
}) {
  return (
    <>
      <PreviewStyle css={previewCss(theme)} />
      <div className="grid gap-3 md:grid-cols-2">
        <MiniShell scheme="light" branding={branding} />
        <MiniShell scheme="dark" branding={branding} />
      </div>
    </>
  );
}
