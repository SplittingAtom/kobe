---
name: data-analysis
description: "Explore and analyze tabular data (CSV, TSV, Parquet, JSON lines, XLSX) offline with pandas and DuckDB: profile columns, run SQL over files, summarize results. Use when the user gives you a data file or asks a quantitative question about data."
---

# Data analysis

Everything runs offline in the sandbox with the preinstalled Python stack (pandas, numpy, DuckDB,
pyarrow, openpyxl). Run the helper scripts with `python`, using this skill's directory as the base
(the scripts are not executable files).

## Workflow

1. **Profile first.** `python scripts/describe.py FILE [--sheet NAME]` prints shape, dtypes, null
   counts, distinct counts, numeric summaries and the top values of text columns. Read it before
   writing any query; check dtypes, nulls and obvious duplicates.
2. **Query with SQL.** `python scripts/sql.py "SELECT ..." --table name=FILE [--table ...] [--out result.csv]`
   registers each file as a DuckDB view (CSV, TSV, Parquet, JSON lines, XLSX) and prints the result
   as a table. Prefer SQL for joins, grouping and window functions.
3. **Use pandas for anything else** (reshaping, cleaning, statistics) in your own short script.
4. **Report** the numbers with the question they answer, the filters and the row counts behind
   them, and any data quality problem you found. Never invent values the data does not contain.
5. For a picture, hand the result to the `charts` skill; for a spreadsheet or document deliverable,
   use `xlsx`, `docx` or `pdf`.

## Rules

- Write outputs under `/workspace` (never next to the input if the input is a shared file).
- Do not download anything: there is no internet access, and no package installs are needed.
- State assumptions (for example how nulls were treated) in the answer.
