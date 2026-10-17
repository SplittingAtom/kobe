"use client";

import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

interface FieldControl {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

/**
 * The accessibility props a control inside a `Field` takes from it: its id (the label's target;
 * set an id on the Field, not the control), the hint and error as its description, and
 * `aria-invalid` while there is an error. A description or `aria-invalid` the control sets itself
 * is kept. Outside a Field the control's own props pass through.
 */
export function useFieldControl(props: {
  readonly id?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
}): {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
} {
  const field = useContext(FieldContext);
  const id = field ? field.id : props.id;
  const describedBy =
    [props["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  const invalid = props["aria-invalid"] ?? (field?.invalid ? true : undefined);
  return {
    ...(id === undefined ? {} : { id }),
    ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
    ...(invalid === undefined ? {} : { "aria-invalid": invalid }),
  };
}

/**
 * One form control with its label above it, an optional hint and an error. The control (a
 * `TextInput`, `Textarea` or `Select` from ./inputs) is the child; it is labelled and described
 * through context, so the field needs no ids. Checkboxes, radios and switches carry their own
 * label inline instead (KOBE-283): use them outside a Field, or in a `ChoiceGroup`.
 */
export function Field({
  id: ownId,
  label,
  hint,
  error,
  children,
  className,
}: {
  /** The control's id, when something else must point at it. */
  readonly id?: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const generated = useId();
  const id = ownId ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div data-slot="console-field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="m-0 text-sm text-console-muted">
          {hint}
        </p>
      )}
      <FieldContext.Provider
        value={{ id, describedBy: describedBy || undefined, invalid: !!error }}
      >
        {children}
      </FieldContext.Provider>
      {error && (
        <p id={errorId} className="m-0 text-sm font-medium text-console-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Fields side by side, wrapping on narrow screens, aligned on their controls' bottom edge. */
export function FormRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="console-form-row"
      className={cn("my-4 flex flex-wrap items-end gap-3", className)}
      {...props}
    />
  );
}
