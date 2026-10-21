"use client";

import { setNonce } from "get-nonce";
import { useEffect } from "react";
import { documentCspNonce } from "../../lib/security/csp-nonce";

/**
 * Hands the document's CSP nonce to `get-nonce` (KOBE-469), which react-style-singleton reads
 * when Radix's modal scroll lock (react-remove-scroll) injects its `<style>`: Next does not set
 * `__webpack_nonce__`, so without this the nonce CSP drops that style. Rendered first in the root
 * layout's body, so its effect runs before any dialog can open. `get-nonce` is pinned to the
 * one version react-style-singleton resolves, so both share its module state.
 */
export function StyleNonce(): null {
  useEffect(() => {
    const nonce = documentCspNonce();
    if (nonce) setNonce(nonce);
  }, []);
  return null;
}
