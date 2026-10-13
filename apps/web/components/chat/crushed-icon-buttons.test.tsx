// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { IconAction, IconActionProvider } from "../shell/icon-action";
import { crushedIconButtons } from "./testing";

/** KOBE-269: the guard against icon buttons the chat's base button padding would crush. */
afterEach(() => cleanup());

const chat = (children: ReactNode) =>
  render(
    <IconActionProvider>
      <div data-kobe-chat>{children}</div>
    </IconActionProvider>,
  );

/** The retention banner's close button as it was before KOBE-269. */
const OLD_CLOSE =
  "hover:bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-md";

describe("crushedIconButtons", () => {
  it("catches the original crushed banner close button", () => {
    chat(
      <button type="button" className={OLD_CLOSE} aria-label="Dismiss retention notice">
        <XIcon aria-hidden className="size-4" />
      </button>,
    );
    expect(crushedIconButtons()).toEqual(["Dismiss retention notice"]);
  });

  it("treats visually hidden text as no text", () => {
    chat(
      <>
        <button type="button" className={OLD_CLOSE}>
          <XIcon aria-hidden />
          <span className="sr-only">Close one</span>
        </button>
        <button type="button" className={OLD_CLOSE}>
          <XIcon aria-hidden />
          <span className="admin-module__x1__visuallyHidden">Close two</span>
        </button>
      </>,
    );
    expect(crushedIconButtons()).toEqual(["Close one", "Close two"]);
  });

  it("only inline padding fixes it: p-0, px-1 and variants pass; py-1 alone does not", () => {
    chat(
      <>
        {["p-0", "px-1", "md:p-0", "!p-0", "py-1"].map((pad) => (
          <button key={pad} type="button" className={`${OLD_CLOSE} ${pad}`} aria-label={pad}>
            <XIcon aria-hidden />
          </button>
        ))}
      </>,
    );
    expect(crushedIconButtons()).toEqual(["py-1"]);
  });

  it("passes IconActions, text buttons and buttons outside the chat", () => {
    chat(
      <>
        <IconAction command="dismiss-notice" label="Dismiss" />
        <button type="button" className={OLD_CLOSE}>
          <XIcon aria-hidden /> Close
        </button>
      </>,
    );
    render(
      <button type="button" className={OLD_CLOSE} aria-label="Elsewhere">
        <XIcon aria-hidden />
      </button>,
    );
    expect(crushedIconButtons()).toEqual([]);
  });
});
