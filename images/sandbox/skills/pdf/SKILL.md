---
name: pdf
description: "Create PDF documents from Markdown-style text with reportlab, and read, search or split existing PDFs (text extraction, page ranges, merge) with pypdf, all offline. Use when the user wants a PDF produced or gives you a PDF to read."
---

# PDF

Offline, with the preinstalled `reportlab` (writing) and `pypdf` (reading). Run scripts with
`python` (not executable files).

## Create a PDF

```
python scripts/md_to_pdf.py INPUT.md /workspace/report.pdf [--title "Quarterly report"]
```

Supported: `#`/`##`/`###` headings, paragraphs, `-` bullets, `1.` numbered items, pipe tables with a
`---` separator row, `**bold**`, `*italic*`. Use `-` as the input to read stdin. For custom layouts
write your own script with `reportlab.platypus` (SimpleDocTemplate, Paragraph, Table, Image).

## Read a PDF

```
python scripts/pdf_text.py FILE.pdf [--pages 1-3,7] [--info]
python scripts/pdf_pages.py OUT.pdf IN.pdf[:1-3] [IN2.pdf ...]    # split or merge by page ranges
```

`pdf_text.py` prints the text layer page by page (`--info` adds metadata and page count). Scanned
PDFs have no text layer and there is no OCR here: say so instead of guessing.

## Rules

- Save under `/workspace`. After writing a PDF, re-read it with `pdf_text.py` and check it.
- Never overwrite the user's original; encrypted PDFs that need a password are out of scope.
