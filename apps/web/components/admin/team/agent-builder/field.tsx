import { useId, type ReactNode } from "react";
import adminStyles from "../../admin.module.css";
import styles from "./agent-builder.module.css";

/** A labelled control with an optional hint and its errors, wired through aria-describedby. */
export function Field({
  label,
  hint,
  errors,
  wide,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly errors?: readonly string[] | undefined;
  readonly wide?: boolean | undefined;
  /** Receives the props that tie the control to its label, hint and errors. */
  readonly children: (control: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  const hasErrors = errors !== undefined && errors.length > 0;
  const describedBy =
    [hint ? `${id}-hint` : null, hasErrors ? `${id}-err` : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className={`${styles.field} ${wide ? styles.wide : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": hasErrors ? true : undefined,
      })}
      {hint && (
        <span id={`${id}-hint`} className={adminStyles.hint}>
          {hint}
        </span>
      )}
      {hasErrors && (
        <p id={`${id}-err`} className={styles.fieldError}>
          {errors.join(" ")}
        </p>
      )}
    </div>
  );
}
