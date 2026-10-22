"use client";

import { useId, useState } from "react";
import { Button, FieldError, Select, TextInput } from "../../../ui/console";

export interface PickOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A list of names picked from options (KOBE-476: the creator's Skills and Connectors pickers):
 * the chosen names with a Remove button each, a dropdown that adds one, and optionally a text
 * box for a name the options don't list (they may not have loaded). Plain controls throughout,
 * so every step works from the keyboard.
 */
export function PickList({
  legend,
  hint,
  chosen,
  options,
  noun,
  readOnly,
  error,
  allowTyped = false,
  onChange,
}: {
  readonly legend: string;
  readonly hint?: string;
  readonly chosen: readonly string[];
  readonly options: readonly PickOption[];
  /** One item, lower case ("skill"): names the controls ("Add a skill", "Remove sql"). */
  readonly noun: string;
  readonly readOnly: boolean;
  readonly error: string | undefined;
  readonly allowTyped?: boolean;
  readonly onChange: (next: readonly string[]) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const available = options.filter((o) => !chosen.includes(o.value));
  const labelOf = (value: string) => options.find((o) => o.value === value)?.label ?? value;
  const add = (value: string) => {
    const name = value.trim();
    if (name !== "" && !chosen.includes(name)) onChange([...chosen, name]);
  };
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      aria-describedby={
        [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") ||
        undefined
      }
    >
      <legend className="mb-1 p-0 font-medium">{legend}</legend>
      {hint && (
        <p id={`${id}-hint`} className="m-0 text-sm text-console-muted">
          {hint}
        </p>
      )}
      {chosen.length === 0 ? (
        <p className="m-0 text-sm text-console-muted">None chosen.</p>
      ) : (
        <ul aria-label={legend} className="m-0 flex list-none flex-wrap gap-2 p-0">
          {chosen.map((value) => (
            <li
              key={value}
              className="flex items-center gap-1 rounded border border-solid border-console-border px-2 py-0.5 text-sm"
            >
              {labelOf(value)}
              {!readOnly && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${labelOf(value)}`}
                  onClick={() => onChange(chosen.filter((c) => c !== value))}
                >
                  ×
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Add a ${noun}`}
            value=""
            disabled={available.length === 0}
            onChange={(e) => add(e.target.value)}
          >
            <option value="">
              {available.length === 0 ? `No more ${noun}s` : `Add a ${noun}…`}
            </option>
            {available.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {allowTyped && (
            <>
              <TextInput
                type="text"
                aria-label={`${noun[0]?.toUpperCase()}${noun.slice(1)} name`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add(typed);
                    setTyped("");
                  }
                }}
              />
              <Button
                onClick={() => {
                  add(typed);
                  setTyped("");
                }}
              >
                Add {noun}
              </Button>
            </>
          )}
        </div>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </fieldset>
  );
}
