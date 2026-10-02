import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

// A software WebAuthn authenticator (ES256, "none" attestation) for tests: produces the same JSON a
// browser returns from navigator.credentials.create/get, so passkey flows run end to end.
const b64url = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string): Buffer => createHash("sha256").update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface CreationOptions {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string };
}

export interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private signCount = 0;
  private userHandle: string | undefined;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: "jwk" });
    return encodeCBOR(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
  }

  private authData(flags: number, attested: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    const parts = [sha256(this.rpId), Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, Buffer.from(this.cosePublicKey()));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }

  /** Response to navigator.credentials.create() for registration options from the server. */
  register(options: CreationOptions): Record<string, unknown> {
    this.userHandle = options.user.id;
    const entries: [string, string | Map<string, string> | Uint8Array][] = [
      ["fmt", "none"],
      ["attStmt", new Map<string, string>()],
      ["authData", new Uint8Array(this.authData(FLAG_UP | FLAG_UV | FLAG_AT, true))],
    ];
    const attestationObject = encodeCBOR(new Map(entries));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** Response to navigator.credentials.get() for authentication options from the server. */
  authenticate(options: RequestOptions, { userVerified = true } = {}): Record<string, unknown> {
    this.signCount += 1;
    const authenticatorData = this.authData(userVerified ? FLAG_UP | FLAG_UV : FLAG_UP, false);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signature = createSign("sha256")
      .update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]))
      .sign(this.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
    };
  }
}
