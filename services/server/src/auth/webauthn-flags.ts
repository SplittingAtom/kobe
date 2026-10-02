import {
  decodeAttestationObject,
  isoBase64URL,
  parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";

/**
 * Whether a WebAuthn response carries the user-verification (UV) flag: biometric or PIN, not just
 * possession. Registration responses carry it inside the attestation object; assertions in
 * authenticatorData. Malformed input counts as not verified.
 */
export function isUserVerified(response: unknown): boolean {
  try {
    const r = (response as { response?: Record<string, unknown> } | undefined)?.response ?? {};
    let authData: Uint8Array<ArrayBuffer>;
    if (typeof r.attestationObject === "string") {
      authData = decodeAttestationObject(isoBase64URL.toBuffer(r.attestationObject)).get(
        "authData",
      );
    } else if (typeof r.authenticatorData === "string") {
      authData = isoBase64URL.toBuffer(r.authenticatorData);
    } else {
      return false;
    }
    return parseAuthenticatorData(authData).flags.uv === true;
  } catch {
    return false;
  }
}
