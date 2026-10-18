"""Profile a data file: python describe.py FILE [--sheet NAME] [--top N]"""

import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _load import load  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file")
    ap.add_argument("--sheet")
    ap.add_argument("--top", type=int, default=5, help="top values shown per text column")
    args = ap.parse_args()

    df = load(args.file, args.sheet)
    print(f"file: {args.file}")
    print(f"rows: {len(df)}  columns: {df.shape[1]}  duplicate rows: {int(df.duplicated().sum())}")
    print()
    summary = pd.DataFrame(
        {
            "dtype": df.dtypes.astype(str),
            "nulls": df.isna().sum(),
            "null%": (df.isna().mean() * 100).round(1),
            "distinct": df.nunique(dropna=True),
        }
    )
    print(summary.to_string())

    numeric = df.select_dtypes("number")
    if not numeric.empty:
        print("\nnumeric columns:")
        print(numeric.describe().T.round(3).to_string())

    for col in df.select_dtypes(exclude="number").columns:
        counts = df[col].value_counts(dropna=True).head(args.top)
        print(f"\ntop values of {col!r}:")
        print(counts.to_string())


if __name__ == "__main__":
    main()
