// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { documentCspNonce } from "../../lib/security/csp-nonce";
import { must } from "../../lib/testing/must";
import CodeEditor from "./code-editor";

/**
 * KOBE-469: the page CSP allows only nonced `<style>`, so every CodeMirror view carries the
 * document's nonce (EditorView.cspNonce) or the browser drops all of its styles.
 */
const NONCE = "test-nonce-469";

/** As the server sends it: the attribute, which the browser keeps as the `nonce` property. */
function addNoncedScript(nonce: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.setAttribute("nonce", nonce);
  script.nonce = nonce;
  document.head.append(script);
  return script;
}

function viewIn(container: HTMLElement): EditorView {
  const editor = must(container.querySelector<HTMLElement>(".cm-editor"));
  return must(EditorView.findFromDOM(editor));
}

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

describe("documentCspNonce", () => {
  it("reads the nonce property of a nonced script (browsers hide the attribute)", () => {
    const script = addNoncedScript(NONCE);
    script.setAttribute("nonce", ""); // what nonce hiding leaves in the DOM
    script.nonce = NONCE;
    expect(documentCspNonce(document)).toBe(NONCE);
  });

  it("is empty when the page has no nonced script", () => {
    expect(documentCspNonce(document)).toBe("");
  });
});

describe("CodeEditor CSP nonce", () => {
  it("gives the plain editor the document's nonce", () => {
    addNoncedScript(NONCE);
    const { container } = render(<CodeEditor value="a\n" language={null} label="Edit a" />);
    expect(viewIn(container).state.facet(EditorView.cspNonce)).toBe(NONCE);
  });

  it("gives the unified merge view the document's nonce", () => {
    addNoncedScript(NONCE);
    const { container } = render(
      <CodeEditor value="a\nB\n" original="a\nb\n" language={null} label="Review a" />,
    );
    expect(viewIn(container).state.facet(EditorView.cspNonce)).toBe(NONCE);
  });
});
