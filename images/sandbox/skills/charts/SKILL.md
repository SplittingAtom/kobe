---
name: charts
description: "Turn tabular data into clear, accessible chart images (PNG or SVG) offline with matplotlib: bar, line, scatter, histogram. Use when the user asks for a chart, plot or visualization of data."
---

# Charts

Charts are rendered offline with matplotlib (headless `Agg` backend); the output is an image file
under `/workspace` that you then show or attach.

## Quick chart from a file

```
python scripts/chart.py DATA.csv --kind bar --x region --y amount --title "Amount by region" --out /workspace/chart.png
```

- `--kind`: `bar`, `line`, `scatter` or `hist` (`hist` needs only `--y`).
- `--y` may repeat for several series. `--agg sum|mean|count|none` aggregates `--y` by `--x`
  first (default `none`).
- `--out` ends in `.png` or `.svg`. Add `--xlabel/--ylabel` when the column names are not readable
  labels, and `--sort` to order bars by value.

For anything more specific, write your own matplotlib script (`import matplotlib; matplotlib.use("Agg")`).

## Chart rules

- Pick the form that fits the question: comparison = bars, trend over time = line, relationship =
  scatter, distribution = histogram. No pie charts for more than a few slices; no 3D.
- Always title the chart, label axes with units, start bar axes at zero, and keep text readable
  (the script uses 10 pt minimum at 1200 px wide).
- Use the colorblind-safe palette in the script; never rely on color alone when series overlap.
- After rendering, check the file exists and say what the chart shows in one sentence.
