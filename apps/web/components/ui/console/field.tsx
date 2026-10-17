"use client";

import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

interface FieldControl {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

type ControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
  required?: boolean;
};

/**
 * The accessibility props a control inside a `Field` takes from it: its id (the label's target;
 * set an id on the Field, not the control), the hint and error as its description,
 * `aria-invalid` while there is an error, and `required`. A description, `aria-invalid` or
 * `required` the control sets itself is kept. Outside a Field the control's own props pass through.
 */
export function useFieldControl(props: {
  readonly id?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
  readonly required?: boolean | undefined;
}): ControlProps {
  const field = useContext(FieldContext);
  const id = field ? field.id : props.id;
  const describedBy =
    [props["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  const invalid = props["aria-invalid"] ?? (field?.invalid ? true : undefined);
  const required = props.required ?? (field?.required ? true : undefined);
  return {
    ...(id === undefined ? {} : { id }),
    ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
    ...(invalid === undefined ? {} : { "aria-invalid": invalid }),
    ...(required === undefined ? {} : { required }),
  };
}

/** "(required)" after a label: screen readers hear the control's own `required` instead. */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ms-1 text-sm font-normal text-console-muted">
      (required)
    </span>
  );
}

/**
 * An error under a control or a group, announced when it appears (`role="alert"`) and pointed
 * at by the control's `aria-describedby`, so it is read again on focus.
 */
export function FieldError({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <p id={id} role="alert" className="m-0 text-sm font-medium text-console-danger">
      {children}
    </p>
  );
}

/**
 * One form control with its label above it, an optional hint and an error. The control (a
 * `TextInput`, `Textarea` or `Select` from ./inputs) is the child; it is labelled, described and
 * marked required through context, so the field needs no ids. Checkboxes, radios and switches
 * carry their own label inline instead (KOBE-283): use them outside a Field, or in a
 * `ChoiceGroup`.
 */
export function Field({
  id: ownId,
  label,
  hint,
  error,
  required = false,
  children,
  className,
}: {
  /** The control's id, when something else must point at it. */
  readonly id?: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  /** Marks the label and sets `required` on the control. */
  readonly required?: boolean;
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
        {required && <RequiredMark />}
      </label>
      {hint && (
        <p id={hintId} className="m-0 text-sm text-console-muted">
          {hint}
        </p>
      )}
      <FieldContext.Provider
        value={{ id, describedBy: describedBy || undefined, invalid: !!error, required }}
      >
        {children}
      </FieldContext.Provider>
      {error && <FieldError id={errorId}>{error}</FieldError>}
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
