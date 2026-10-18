---
name: docx
description: "Create and read Word (.docx) documents offline with python-docx: turn Markdown-style text into a formatted document, or extract the text and tables of an existing .docx. Use when the user wants a Word document or gives you one."
---

# Word documents (.docx)

Offline, with the preinstalled `python-docx`. Run scripts with `python` (not executable files).

## Create from Markdown-style text

```
python scripts/md_to_docx.py INPUT.md /workspace/report.docx [--title "Quarterly report"]
```

Supported: `#`/`##`/`###` headings, paragraphs, `-`/`*` bullets, `1.` numbered items, pipe tables
(`| a | b |` with a `---` separator row), `**bold**` and `*italic*`. Write the content to a `.md`
file first (or `-` to read stdin), then convert.

## Read an existing document

```
python scripts/docx_text.py FILE.docx
```

Prints paragraphs (with their style names) and tables in document order. To edit a document, load it
with `docx.Document(path)`, change paragraphs or table cells, and save under a new name; do not
overwrite the user's original.

## Rules

- Save under `/workspace`. After writing, re-read the file with `docx_text.py` and check it.
- Headings should form an outline (one `#` title, then `##` sections); keep tables small and give
  them a header row.
- You cannot render the document to check the layout; keep formatting simple.
