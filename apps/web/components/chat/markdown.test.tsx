// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, safeUrl } from "./markdown";

afterEach(() => cleanup());

function html(text: string): HTMLElement {
  return render(<Markdown text={text} />).container;
}

/** Nothing executable or loading: no script/iframe/img/object, no on* or style attributes. */
function expectInert(root: HTMLElement) {
  for (const tag of ["script", "iframe", "img", "object", "embed", "style", "form", "math"]) {
    expect(root.querySelector(tag), tag).toBeNull();
  }
  // Only Kobe's own icons (inside the code block's copy button) may be SVG, never agent text.
  expect(
    [...root.querySelectorAll("svg")].filter((svg) => svg.closest("button") === null),
    "svg",
  ).toHaveLength(0);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith("on"), `${el.tagName} ${attr}`).toBe(false);
      expect(attr, el.tagName).not.toBe("style");
    }
  }
  for (const a of root.querySelectorAll("a")) {
    expect(a.getAttribute("href")).toMatch(/^(https?:|mailto:)/);
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a.getAttribute("target")).toBe("_blank");
  }
}

describe("Markdown (agent text)", () => {
  it("renders GFM: headings, lists, tables, task lists, code", () => {
    const root = html(
      [
        "## Result",
        "",
        "- one",
        "- [x] done",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```python",
        "print('hi')",
        "```",
        "",
        "~~old~~ **bold** `inline`",
      ].join("\n"),
    );
    expect(root.querySelector("h2")?.textContent).toBe("Result");
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(root.querySelector("table td")?.textContent).toBe("1");
    expect(root.querySelector("pre code")?.textContent).toBe("print('hi')\n");
    expect(root.querySelector("del")?.textContent).toBe("old");
    expectInert(root);
  });

  it.each([
    ["script tag", "<script>alert(1)</script>"],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["iframe", '<iframe src="https://evil.example"></iframe>'],
    ["inline handler", '<a href="https://ok.example" onclick="alert(1)">x</a>'],
    ["svg", "<svg onload=alert(1)><circle/></svg>"],
    ["style", "<style>body{display:none}</style>"],
    ["javascript link", "[click](javascript:alert(1))"],
    ["mixed-case scheme", "[click](JaVaScRiPt:alert(1))"],
    ["spaced scheme", "[click]( javascript:alert(1))"],
    ["entity-encoded scheme", "[click](&#106;avascript:alert(1))"],
    ["tab in scheme", "[click](java\tscript:alert(1))"],
    ["data URL", "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["vbscript", "[click](vbscript:msgbox(1))"],
    ["autolink", "<javascript:alert(1)>"],
    ["reference link", "[click][r]\n\n[r]: javascript:alert(1)"],
    ["image", "![pixel](https://tracker.example/p.png)"],
    ["data image", "![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)"],
    ["html in table", "| a |\n| - |\n| <img src=x onerror=alert(1)> |"],
    ["relative link", "[home](/admin)"],
  ])("is inert for hostile input: %s", (_label, text) => {
    expectInert(html(text));
  });

  it("shows raw HTML as text instead of dropping or parsing it", () => {
    const root = html("Use the <div> tag, then <script>alert(1)</script>.");
    expect(root.textContent).toContain("<div>");
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expectInert(root);
  });

  it("keeps safe links (new tab, no referrer, nofollow) and shows unsafe ones as text", () => {
    const root = html(
      "[docs](https://kobe.example/docs) [mail](mailto:a@b.example) [bad](javascript:x)",
    );
    expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://kobe.example/docs",
      "mailto:a@b.example",
    ]);
    expect(screen.getByText("bad").tagName).toBe("SPAN");
  });

  it("never loads images: a safe image becomes a link, an unsafe one its alt text", () => {
    const root = html("![chart](https://files.example/c.png) ![x](javascript:alert(1))");
    expect(root.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "[Image: chart]" });
    expect(link.getAttribute("href")).toBe("https://files.example/c.png");
    expect(screen.getByText("[Image: x]").tagName).toBe("SPAN");
  });

  it("copies a code block", async () => {
    const user = userEvent.setup(); // provides a clipboard
    html("```\nls -la\n```");
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await navigator.clipboard.readText()).toBe("ls -la\n");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});

describe("safeUrl", () => {
  it.each([
    ["https://a.example/x?y=1", "https://a.example/x?y=1"],
    ["http://a.example", "http://a.example/"],
    ["mailto:x@y.example", "mailto:x@y.example"],
    ["javascript:alert(1)", undefined],
    [" JAVASCRIPT:alert(1)", undefined],
    ["data:text/html,x", undefined],
    ["/relative", undefined],
    ["//evil.example", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("%j → %j", (input, expected) => {
    expect(safeUrl(input)).toBe(expected);
  });
});
