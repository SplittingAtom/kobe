"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../../../lib/utils";
import { Button, FieldError, FOCUS_RING, TextInput } from "../../../ui/console";
import { AGENT_ICONS, searchAgentIcons } from "./agent-icons";

/** The chosen icon as shown on the button: its glyph, or a stored emoji / unknown name as text. */
export function AgentIconGlyph({
  name,
  className,
}: {
  readonly name: string;
  readonly className?: string;
}) {
  const Icon = AGENT_ICONS.get(name);
  if (Icon) return <Icon aria-hidden="true" className={cn("size-4", className)} />;
  return name === "" ? null : (
    <span aria-hidden="true" className={className}>
      {name}
    </span>
  );
}

/**
 * The agent's icon (KOBE-476 AC3): a dropdown with a search box over the app's icon set. It stores
 * the icon's kebab-case name in the existing `icon` field; a stored emoji or a name outside the
 * set is kept and shown as text. Keyboard: the button opens it, the search box takes focus, Tab
 * reaches every icon, Escape closes and returns focus to the button.
 */
export function IconPicker({
  value,
  readOnly,
  error,
  onChange,
}: {
  readonly value: string;
  readonly readOnly: boolean;
  readonly error: string | undefined;
  readonly onChange: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const matches = useMemo(() => searchAgentIcons(query), [query]);

  function close() {
    setOpen(false);
    setQuery("");
    button.current?.focus();
  }

  function choose(icon: string) {
    onChange(icon);
    close();
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-sm font-medium">
        Icon
      </span>
      <Button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${id}-value`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={readOnly}
        className="justify-start gap-2 self-start"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <AgentIconGlyph name={value} />
        <span id={`${id}-value`}>{value === "" ? "No icon" : value}</span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose an icon"
          className="rounded border border-solid border-console-border bg-console-panel p-2"
          onKeyDown={onKeyDown}
        >
          <TextInput
            type="search"
            aria-label="Search icons"
            autoFocus
            value={query}
            className="mb-2 w-full"
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul
            aria-label="Icons"
            className="m-0 grid max-h-56 list-none grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1 overflow-y-auto p-0"
          >
            <li>
              <button
                type="button"
                aria-pressed={value === ""}
                className={iconButton(value === "")}
                onClick={() => choose("")}
              >
                No icon
              </button>
            </li>
            {matches.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  aria-pressed={value === name}
                  className={iconButton(value === name)}
                  onClick={() => choose(name)}
                >
                  <AgentIconGlyph name={name} />
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && (
            <p role="status" className="m-0 mt-2 text-sm text-console-muted">
              No icon matches “{query}”.
            </p>
          )}
        </div>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

const iconButton = (selected: boolean) =>
  cn(
    "flex w-full cursor-pointer items-center gap-2 rounded border border-solid px-2 py-1 text-left text-sm",
    selected
      ? "border-console-accent bg-console-bg font-semibold"
      : "border-transparent bg-transparent hover:bg-console-bg",
    FOCUS_RING,
  );
