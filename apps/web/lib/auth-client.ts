"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

/** Browser client for the server's Better Auth endpoints (same origin, under /api/auth). */
export const authClient = createAuthClient({
  plugins: [passkeyClient(), twoFactorClient()],
});
