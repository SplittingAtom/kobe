/**
 * The Raw view's language modes (KOBE-463), each loaded only when a file of that kind opens.
 * Imported only by `code-editor.tsx`, itself loaded lazily, so none of it is in the chat bundle.
 */
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { EditorLanguage } from "../../lib/files/editor";

/** CSV/TSV: quoted fields as strings, the delimiter as punctuation, numbers as numbers. */
function delimited(delimiter: string): StreamParser<{ quoted: boolean }> {
  return {
    name: delimiter === "\t" ? "tsv" : "csv",
    startState: () => ({ quoted: false }),
    token(stream, state) {
      if (state.quoted || stream.peek() === '"') {
        if (!state.quoted) stream.next();
        state.quoted = true;
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === '"' && !stream.eat('"')) {
            state.quoted = false;
            break;
          }
        }
        return "string";
      }
      if (stream.eat(delimiter)) return "punctuation";
      if (stream.match(/^-?\d+(\.\d+)?(?=$|[\t,])/)) return "number";
      while (!stream.eol() && stream.peek() !== delimiter) stream.next();
      return null;
    },
  };
}

export async function languageExtension(language: EditorLanguage | null): Promise<Extension> {
  switch (language) {
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "json":
      return (await import("@codemirror/lang-json")).jsonLanguage;
    case "csv":
      return StreamLanguage.define(delimited(","));
    case "tsv":
      return StreamLanguage.define(delimited("\t"));
    case "python":
      return (await import("@codemirror/lang-python")).pythonLanguage;
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascriptLanguage;
    case "jsx":
      return (await import("@codemirror/lang-javascript")).jsxLanguage;
    case "typescript":
      return (await import("@codemirror/lang-javascript")).typescriptLanguage;
    case "tsx":
      return (await import("@codemirror/lang-javascript")).tsxLanguage;
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yamlLanguage;
    case null:
      return [];
  }
}
