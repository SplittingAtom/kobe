/**
 * zod (used by `@kobe/protocol` and assistant-ui) probes for `eval` with `Function("")` to compile
 * fast validators. The CSP forbids eval (`lib/security/csp.ts`), so the probe would only report a
 * violation: validate without it. Imported for its effect before anything parses.
 */
import { config } from "zod";

config({ jitless: true });
