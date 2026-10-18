"""Shared loader for the data-analysis scripts: one file -> pandas DataFrame."""

import sys
from pathlib import Path

import pandas as pd


def load(path: str, sheet: str | None = None) -> pd.DataFrame:
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix in (".csv", ".txt"):
        return pd.read_csv(p)
    if suffix in (".tsv", ".tab"):
        return pd.read_csv(p, sep="\t")
    if suffix == ".parquet":
        return pd.read_parquet(p)
    if suffix in (".jsonl", ".ndjson"):
        return pd.read_json(p, lines=True)
    if suffix == ".json":
        return pd.read_json(p)
    if suffix in (".xlsx", ".xlsm"):
        return pd.read_excel(p, sheet_name=sheet if sheet is not None else 0)
    sys.exit(f"unsupported file type: {suffix or p.name}")
