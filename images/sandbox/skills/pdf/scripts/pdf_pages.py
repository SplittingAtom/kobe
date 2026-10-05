"""Split or merge PDFs by page ranges: python pdf_pages.py OUT.pdf IN.pdf[:1-3,7] [IN2.pdf[:2-] ...]"""

import sys

from pypdf import PdfReader, PdfWriter


def pages_of(spec: str, total: int) -> list[int]:
    pages: list[int] = []
    for part in spec.split(","):
        lo, _, hi = part.partition("-")
        start = int(lo or 1)
        end = total if part.endswith("-") else int(hi or lo)
        if not 1 <= start <= end <= total:
            sys.exit(f"page range {part!r} outside 1-{total}")
        pages += range(start, end + 1)
    return pages


def main() -> None:
    if len(sys.argv) < 3 or not sys.argv[1].lower().endswith(".pdf"):
        sys.exit(__doc__)
    writer = PdfWriter()
    for arg in sys.argv[2:]:
        path, _, spec = arg.partition(":")
        reader = PdfReader(path)
        if reader.is_encrypted:
            sys.exit(f"{path} is encrypted")
        for n in pages_of(spec, len(reader.pages)) if spec else range(1, len(reader.pages) + 1):
            writer.add_page(reader.pages[n - 1])
    with open(sys.argv[1], "wb") as fh:
        writer.write(fh)
    print(f"wrote {sys.argv[1]} ({len(writer.pages)} pages)")


if __name__ == "__main__":
    main()
