"""Markdown-style text -> PDF: python md_to_pdf.py INPUT.md|- OUTPUT.pdf [--title TEXT]"""

import argparse
import re
import sys
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def inline(text: str) -> str:
    out = escape(text)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", out)
    return re.sub(r"\*([^*]+)\*", r"<i>\1</i>", out)


def split_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    cells = split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


def build(text: str, title: str | None) -> list:
    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    flow: list = []
    if title:
        flow += [Paragraph(inline(title), styles["Title"]), Spacer(1, 4 * mm)]
    lines = text.splitlines()
    i, buf = 0, []
    items: list[str] = []
    ordered = False

    def flush() -> None:
        nonlocal ordered
        if buf:
            flow.append(Paragraph(inline(" ".join(buf)), body))
            buf.clear()
        if items:
            flow.append(
                ListFlowable(
                    [ListItem(Paragraph(inline(t), body)) for t in items],
                    bulletType="1" if ordered else "bullet",
                )
            )
            items.clear()

    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            flush()
        elif (m := re.match(r"(#{1,3})\s+(.*)", line)):
            flush()
            flow.append(Paragraph(inline(m.group(2)), styles[f"Heading{len(m.group(1))}"]))
        elif (m := re.match(r"\s*([-*]|\d+[.)])\s+(.*)", line)):
            if buf:
                flush()
            kind_ordered = m.group(1)[0].isdigit()
            if items and kind_ordered != ordered:
                flush()
            ordered = kind_ordered
            items.append(m.group(2))
        elif line.lstrip().startswith("|") and i + 1 < len(lines) and is_separator(lines[i + 1]):
            flush()
            rows = [split_row(line)]
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            cells = [[Paragraph(inline(c), body) for c in row] for row in rows]
            table = Table(cells, repeatRows=1)
            table.setStyle(
                TableStyle(
                    [
                        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF4")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ]
                )
            )
            flow += [table, Spacer(1, 3 * mm)]
            continue
        else:
            if items:
                flush()
            buf.append(line.strip())
        i += 1
    flush()
    return flow


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--title")
    args = ap.parse_args()
    if not args.output.lower().endswith(".pdf"):
        sys.exit("output must end in .pdf")
    text = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8").read()
    doc = SimpleDocTemplate(
        args.output, pagesize=A4, title=args.title or "", leftMargin=20 * mm, rightMargin=20 * mm
    )
    doc.build(build(text, args.title))
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
