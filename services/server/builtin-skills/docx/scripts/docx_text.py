"""Print the text and tables of a .docx in document order: python docx_text.py FILE.docx"""

import sys

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    doc = Document(sys.argv[1])
    for child in doc.element.body.iterchildren():
        if child.tag.endswith("}p"):
            p = Paragraph(child, doc)
            if p.text.strip():
                print(f"[{p.style.name}] {p.text}")
        elif child.tag.endswith("}tbl"):
            for row in Table(child, doc).rows:
                print("| " + " | ".join(c.text.strip() for c in row.cells) + " |")


if __name__ == "__main__":
    main()
