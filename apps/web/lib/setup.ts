export interface SetupInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

/** Client-side check mirroring the server's rules (the server stays authoritative). */
export function validateSetup(input: SetupInput): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return "Enter a valid email address.";
  if (input.name.trim().length === 0) return "Enter your name.";
  if (input.password.length < 12) return "Use at least 12 characters for the password.";
  if (input.password.length > 128) return "Use at most 128 characters for the password.";
  return null;
}
