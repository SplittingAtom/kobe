"use client";

/** CSV or TSV as a table of text cells (artifacts, KOBE-130; workspace files, KOBE-268). */
import { parseCsv } from "../../lib/chat/artifacts";

const MAX_CSV_ROWS = 1000;

export function CsvTable({
  text,
  delimiter = ",",
}: {
  readonly text: string;
  readonly delimiter?: string;
}) {
  const rows = parseCsv(text, delimiter);
  const [head, ...body] = rows;
  if (!head) return <p>This artifact is empty.</p>;
  const shown = body.slice(0, MAX_CSV_ROWS);
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th key={i} scope="col" className="bg-muted border px-2 py-1 text-start font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border px-2 py-1">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        <p className="text-muted-foreground mt-2 text-xs">
          Showing the first {MAX_CSV_ROWS} of {body.length} rows. Download the file for all of them.
        </p>
      )}
    </div>
  );
}
