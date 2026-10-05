"""Run SQL over data files with DuckDB.

python sql.py "SELECT region, sum(amount) FROM sales GROUP BY 1" --table sales=sales.csv [--out out.csv]
"""

import argparse
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _load import load  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("query")
    ap.add_argument("--table", action="append", default=[], metavar="NAME=FILE")
    ap.add_argument("--out", help="also write the result to this .csv or .parquet file")
    ap.add_argument("--max-rows", type=int, default=50, help="rows printed (the file gets all)")
    args = ap.parse_args()

    con = duckdb.connect(":memory:")
    # No extension loading or installs: the sandbox has no internet and files are read via pandas.
    for spec in args.table:
        name, sep, path = spec.partition("=")
        if not sep or not name.isidentifier():
            sys.exit(f"--table expects NAME=FILE with an identifier name, got {spec!r}")
        frame = load(path)
        con.register(name, frame)

    result = con.execute(args.query).df()
    print(result.head(args.max_rows).to_string(index=False))
    if len(result) > args.max_rows:
        print(f"... {len(result)} rows in total")
    if args.out:
        out = Path(args.out)
        if out.suffix == ".parquet":
            result.to_parquet(out, index=False)
        else:
            result.to_csv(out, index=False)
        print(f"wrote {len(result)} rows to {out}")


if __name__ == "__main__":
    main()
