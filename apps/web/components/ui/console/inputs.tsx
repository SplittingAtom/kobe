"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { useFieldControl } from "./field";

/** Text-like controls: no preflight on these pages, so the classes reset the browser's look. */
const CONTROL =
  "m-0 box-border min-h-8 rounded-md border border-console-border bg-console-bg px-2 py-1 font-[inherit] text-sm leading-5 text-console-fg disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-console-danger";

/** A single-line input; inside a `Field` it takes the field's label, hint and error. */
export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="console-input"
      {...props}
      {...useFieldControl(props)}
      className={cn(CONTROL, className)}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="console-textarea"
      {...props}
      {...useFieldControl(props)}
      className={cn(CONTROL, "min-h-20", className)}
    />
  );
}

/** The native select: its popup is the platform's, themed by `color-scheme` (app/theme.css). */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="console-select"
      {...props}
      {...useFieldControl(props)}
      className={cn(CONTROL, "cursor-pointer pe-6", className)}
    />
  );
}

type ChoiceProps = Omit<ComponentProps<"input">, "type"> & {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
};

/**
 * A checkbox or radio inline before its text, in one label (KOBE-283): the box never stacks on
 * its own row, wherever it sits. Its hint is its description.
 */
function Choice({
  type,
  label,
  hint,
  className,
  ...props
}: ChoiceProps & { readonly type: "checkbox" | "radio" }) {
  const hintId = useId();
  const describedBy = [props["aria-describedby"], hint ? hintId : null].filter(Boolean).join(" ");
  return (
    <span data-slot="console-choice" className={cn("inline-flex flex-col", className)}>
      <label className="inline-flex cursor-pointer items-center gap-2 has-disabled:cursor-not-allowed has-disabled:opacity-60">
        <input
          type={type}
          {...props}
          aria-describedby={describedBy || undefined}
          className="m-0 size-4 shrink-0 cursor-[inherit] accent-console-accent"
        />
        <span>{label}</span>
      </label>
      {hint && (
        <span id={hintId} className="ms-6 text-sm text-console-muted">
          {hint}
        </span>
      )}
    </span>
  );
}

export function Checkbox(props: ChoiceProps) {
  return <Choice type="checkbox" {...props} />;
}

export function Radio(props: ChoiceProps) {
  return <Choice type="radio" {...props} />;
}

/** Related choices (radios, or checkboxes) under one legend; side by side unless `stacked`. */
export function ChoiceGroup({
  legend,
  hint,
  stacked = false,
  children,
  className,
}: {
  readonly legend: ReactNode;
  readonly hint?: ReactNode;
  readonly stacked?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const hintId = useId();
  return (
    <fieldset
      data-slot="console-choice-group"
      aria-describedby={hint ? hintId : undefined}
      className={cn("m-0 min-w-0 border-0 p-0", className)}
    >
      <legend className="mb-1 p-0 font-medium">{legend}</legend>
      {hint && (
        <p id={hintId} className="m-0 mb-1 text-sm text-console-muted">
          {hint}
        </p>
      )}
      <div className={cn("flex gap-x-4 gap-y-1", stacked ? "flex-col" : "flex-wrap")}>
        {children}
      </div>
    </fieldset>
  );
}

/**
 * An on/off setting that applies at once (Radix Switch: a button with role `switch`). For a
 * choice that is saved with a form, use a Checkbox.
 */
export function Switch({
  label,
  hint,
  className,
  id,
  ...props
}: Omit<ComponentProps<typeof SwitchPrimitive.Root>, "children"> & {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
}) {
  const ownId = useId();
  const switchId = id ?? ownId;
  const hintId = `${switchId}-hint`;
  return (
    <span data-slot="console-switch-row" className={cn("inline-flex flex-col", className)}>
      <span className="inline-flex items-center gap-2">
        <SwitchPrimitive.Root
          id={switchId}
          data-slot="console-switch"
          aria-describedby={hint ? hintId : undefined}
          className="m-0 box-border inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-console-muted p-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-console-accent"
          {...props}
        >
          <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-console-bg shadow-sm transition-transform data-[state=checked]:translate-x-4" />
        </SwitchPrimitive.Root>
        <label htmlFor={switchId} className="cursor-pointer">
          {label}
        </label>
      </span>
      {hint && (
        <span id={hintId} className="ms-11 text-sm text-console-muted">
          {hint}
        </span>
      )}
    </span>
  );
}
