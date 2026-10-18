"""Render a chart from a CSV/TSV/Parquet/XLSX file with matplotlib (offline).

python chart.py FILE --kind bar|line|scatter|hist --x COL --y COL [--y COL ...] --out chart.png
"""

import argparse
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

# Okabe-Ito: colorblind-safe.
PALETTE = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000"]


def load(path: str) -> pd.DataFrame:
    suffix = Path(path).suffix.lower()
    if suffix == ".parquet":
        return pd.read_parquet(path)
    if suffix in (".xlsx", ".xlsm"):
        return pd.read_excel(path)
    return pd.read_csv(path, sep="\t" if suffix in (".tsv", ".tab") else ",")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--kind", choices=["bar", "line", "scatter", "hist"], required=True)
    ap.add_argument("--x")
    ap.add_argument("--y", action="append", default=[])
    ap.add_argument("--agg", choices=["none", "sum", "mean", "count"], default="none")
    ap.add_argument("--title", default="")
    ap.add_argument("--xlabel")
    ap.add_argument("--ylabel")
    ap.add_argument("--sort", action="store_true", help="sort bars by value, descending")
    ap.add_argument("--bins", type=int, default=20)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    df = load(args.file)
    if not args.y:
        sys.exit("--y is required")
    for col in [*args.y, *([args.x] if args.x else [])]:
        if col not in df.columns:
            sys.exit(f"column {col!r} not in {list(df.columns)}")
    if args.kind != "hist" and not args.x:
        sys.exit("--x is required for this chart kind")
    if args.agg != "none":
        df = df.groupby(args.x, as_index=False)[args.y].agg(args.agg)
    if args.sort and args.kind == "bar":
        df = df.sort_values(args.y[0], ascending=False)

    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
    fig, ax = plt.subplots(figsize=(12, 6.75), dpi=100)
    if args.kind == "bar":
        width = 0.8 / len(args.y)
        base = range(len(df))
        for i, col in enumerate(args.y):
            ax.bar([b + i * width for b in base], df[col], width, label=col, color=PALETTE[i % 8])
        ax.set_xticks([b + width * (len(args.y) - 1) / 2 for b in base], df[args.x].astype(str))
        ax.set_ylim(bottom=min(0, float(df[args.y].min().min())))
    elif args.kind == "line":
        for i, col in enumerate(args.y):
            ax.plot(df[args.x], df[col], marker="o", label=col, color=PALETTE[i % 8])
    elif args.kind == "scatter":
        for i, col in enumerate(args.y):
            ax.scatter(df[args.x], df[col], label=col, color=PALETTE[i % 8], alpha=0.8)
    else:
        for i, col in enumerate(args.y):
            ax.hist(df[col].dropna(), bins=args.bins, alpha=0.7, label=col, color=PALETTE[i % 8])
    ax.set_title(args.title, loc="left", fontweight="bold")
    ax.set_xlabel(args.xlabel if args.xlabel is not None else (args.x or ""))
    ax.set_ylabel(args.ylabel if args.ylabel is not None else (args.y[0] if len(args.y) == 1 else ""))
    ax.grid(axis="y", alpha=0.3)
    if len(args.y) > 1:
        ax.legend(frameon=False)
    fig.tight_layout()
    out = Path(args.out)
    if out.suffix.lower() not in (".png", ".svg"):
        sys.exit("--out must end in .png or .svg")
    fig.savefig(out)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
