---
name: xlsx
description: "Create, read and inspect Excel (.xlsx) workbooks offline with openpyxl and pandas: write formatted sheets from CSV or data frames, add formulas, dump the contents of an existing workbook. Use when the user wants a spreadsheet or gives you one."
---

# Excel workbooks (.xlsx)

Offline, with the preinstalled `openpyxl` and `pandas`. Run scripts with `python` (not executable
files).

## Create from CSV

```
python scripts/csv_to_xlsx.py DATA.csv /workspace/out.xlsx [--sheet Data] [--total-row]
```

Writes one formatted sheet: bold header, frozen header row, autofilter, sensible column widths,
numbers stored as numbers. `--total-row` appends a `SUM` formula row for the numeric columns. More
sheets: use `pandas.ExcelWriter(path, engine="openpyxl")` and `DataFrame.to_excel(..., sheet_name=...)`.

## Inspect a workbook

```
python scripts/xlsx_dump.py FILE.xlsx [--max-rows 20] [--formulas]
```

Lists each sheet with its dimensions and prints the first rows. `--formulas` shows formulas instead
of the values cached by the application that last saved the file.

## Rules

- Save under `/workspace`; never overwrite the user's original (save a copy, then edit that).
- openpyxl writes formulas but does not calculate them, and there is no spreadsheet application
  here: a file you wrote has no cached values until someone opens it in Excel. Compute numbers with
  pandas when you must state them, and use formulas for what the user will keep editing.
- Keep one table per sheet with a header row and no merged cells; it keeps the data usable.
