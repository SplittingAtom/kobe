/**
 * The CSP nonce of the current document (KOBE-469), for client libraries that inject `<style>`
 * (CodeMirror's `EditorView.cspNonce`): the page CSP (csp.ts) allows only nonced `<style>`.
 *
 * Read from the DOM, not passed down from the layout: Next puts the request's nonce on its own
 * scripts, so a nonced script's `nonce` *property* holds exactly the nonce the document's CSP
 * accepts. (Browsers hide the attribute, which reads as "" once the element is connected, so the
 * property is the only source.) A layout prop or context would instead carry the nonce of
 * whichever request last rendered the layout (a refresh or an RSC fetch renders it again with a
 * fresh nonce), which the document's CSP, fixed at its first load, would refuse. It also keeps
 * the nonce out of the RSC payload.
 */
export function documentCspNonce(doc: Document = document): string {
  for (const script of doc.querySelectorAll<HTMLScriptElement>("script[nonce]")) {
    if (script.nonce) return script.nonce;
  }
  return "";
}
