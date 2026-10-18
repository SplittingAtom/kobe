"""Markdown-style text -> .docx: python md_to_docx.py INPUT.md|- OUTPUT.docx [--title TEXT]"""

import argparse
import re
import sys

from docx import Document

INLINE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*)")


def add_runs(paragraph, text: str) -> None:
    for part in INLINE.split(text):
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            paragraph.add_run(part[2:-2]).bold = True
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            paragraph.add_run(part[1:-1]).italic = True
        elif part:
            paragraph.add_run(part)


def split_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    cells = split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


def convert(text: str, title: str | None) -> Document:
    doc = Document()
    if title:
        doc.add_heading(title, level=0)
    lines = text.splitlines()
    i, buf = 0, []

    def flush() -> None:
        if buf:
            add_runs(doc.add_paragraph(), " ".join(buf))
            buf.clear()

    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            flush()
        elif (m := re.match(r"(#{1,3})\s+(.*)", line)):
            flush()
            doc.add_heading(m.group(2), level=len(m.group(1)))
        elif (m := re.match(r"\s*[-*]\s+(.*)", line)):
            flush()
            add_runs(doc.add_paragraph(style="List Bullet"), m.group(1))
        elif (m := re.match(r"\s*\d+[.)]\s+(.*)", line)):
            flush()
            add_runs(doc.add_paragraph(style="List Number"), m.group(1))
        elif line.lstrip().startswith("|") and i + 1 < len(lines) and is_separator(lines[i + 1]):
            flush()
            header = split_row(line)
            rows = []
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            table = doc.add_table(rows=1, cols=len(header))
            table.style = "Table Grid"
            for cell, value in zip(table.rows[0].cells, header):
                cell.text = ""
                cell.paragraphs[0].add_run(value).bold = True
            for row in rows:
                cells = table.add_row().cells
                for cell, value in zip(cells, row):
                    cell.text = value
            continue
        else:
            buf.append(line.strip())
        i += 1
    flush()
    return doc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--title")
    args = ap.parse_args()
    if not args.output.lower().endswith(".docx"):
        sys.exit("output must end in .docx")
    text = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8").read()
    convert(text, args.title).save(args.output)
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
