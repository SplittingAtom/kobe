"""Print the text of a PDF: python pdf_text.py FILE.pdf [--pages 1-3,7] [--info]"""

import argparse
import sys

from pypdf import PdfReader


def page_numbers(spec: str | None, total: int) -> list[int]:
    if not spec:
        return list(range(1, total + 1))
    pages: list[int] = []
    for part in spec.split(","):
        lo, _, hi = part.partition("-")
        start, end = int(lo), int(hi or lo)
        if not 1 <= start <= end <= total:
            sys.exit(f"page range {part!r} outside 1-{total}")
        pages += range(start, end + 1)
    return pages


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file")
    ap.add_argument("--pages")
    ap.add_argument("--info", action="store_true")
    args = ap.parse_args()
    reader = PdfReader(args.file)
    if reader.is_encrypted:
        sys.exit("the PDF is encrypted; it cannot be read without its password")
    if args.info:
        print(f"pages: {len(reader.pages)}")
        for key, value in (reader.metadata or {}).items():
            print(f"{key}: {value}")
    for n in page_numbers(args.pages, len(reader.pages)):
        print(f"--- page {n} ---")
        print((reader.pages[n - 1].extract_text() or "").strip())


if __name__ == "__main__":
    main()
