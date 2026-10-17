/**
 * A field's schema errors as one message for the console `Field`'s `error` (shown under the
 * control, announced, and in its description), or nothing when it has none.
 */
export function fieldError(errors: readonly string[] | undefined): string | undefined {
  return errors !== undefined && errors.length > 0 ? errors.join(" ") : undefined;
}
