// A SCIM 2.0 client that replays Microsoft Entra ID's provisioning requests (KOBE-633, spec
// docs/specs/sso-oidc-scim.md §10, §17 SSO-9), in the shapes Entra's provisioning service sends:
// the random `userName eq` probe, the create with the enterprise extension and `roles`, PATCH with
// capitalised `op`s, `emails[type eq "work"].value` paths and path-less value objects, `active` as
// the strings "False" / "True" (soft delete, reactivation), then DELETE.
//
// No imports: e2e/gate-sso.sh appends this file to the client it runs in a server pod
// (`node --input-type=module -e`), and the unit test imports it.

export const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

/** `base` is the provider's Tenant URL (…/v1/scim/v2/<slug>); `token` the Secret Token. */
export function scimClient({ base, token, fetchImpl = globalThis.fetch, headers = {} }) {
  const log = [];
  async function request(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/scim+json",
        ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
        // Entra's provisioning service identifies itself; Kobe ignores it.
        "user-agent": "Microsoft.Identity.Provisioning",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    log.push(`${method} ${path.split("?")[0]} ${res.status}`);
    return { status: res.status, json, contentType: res.headers.get("content-type") ?? "" };
  }
  return { request, log };
}

const filterPath = (attr, value) => `/Users?filter=${encodeURIComponent(`${attr} eq "${value}"`)}`;

/** Entra's create body for a user (attribute mapping with externalId ← objectId). */
export function entraUserBody(u) {
  const [givenName, ...rest] = (u.name ?? u.userName).split(" ");
  return {
    schemas: [SCIM_USER, SCIM_ENTERPRISE],
    externalId: u.externalId,
    userName: u.userName,
    active: true,
    displayName: u.name,
    emails: [{ primary: true, type: "work", value: u.email ?? u.userName }],
    meta: { resourceType: "User" },
    name: { formatted: u.name, familyName: rest.join(" ") || givenName, givenName },
    roles: [],
    [SCIM_ENTERPRISE]: { department: "Engineering" },
  };
}

const patch = (Operations) => ({ schemas: [SCIM_PATCH], Operations });

/**
 * The provisioning cycle's requests, each returning the response. `scim` is a {@link scimClient}.
 */
export const entra = {
  /** The connection test: a random userName must answer an empty list. */
  probe: (scim) => scim.request("GET", filterPath("userName", globalThis.crypto.randomUUID())),
  /** Matching before create: Entra looks the user up by its matching attribute (userName). */
  findByUserName: (scim, userName) => scim.request("GET", filterPath("userName", userName)),
  findByExternalId: (scim, externalId) => scim.request("GET", filterPath("externalId", externalId)),
  get: (scim, id) => scim.request("GET", `/Users/${id}`),
  create: (scim, u) => scim.request("POST", "/Users", entraUserBody(u)),
  /** Attribute changes as Entra sends them: `Replace`/`Add` paths, then a path-less object. */
  updateAttributes: (scim, id, { name, email, givenName, familyName }) =>
    scim.request(
      "PATCH",
      `/Users/${id}`,
      patch([
        ...(email === undefined
          ? []
          : [{ op: "Replace", path: 'emails[type eq "work"].value', value: email }]),
        ...(familyName === undefined
          ? []
          : [{ op: "Add", path: "name.familyName", value: familyName }]),
        ...(name === undefined
          ? []
          : [
              {
                op: "replace",
                value: { displayName: name, ...(givenName ? { "name.givenName": givenName } : {}) },
              },
            ]),
      ]),
    ),
  /** Soft delete (unassigned from the app, or blocked from signing in): `active` "False". */
  deactivate: (scim, id) =>
    scim.request(
      "PATCH",
      `/Users/${id}`,
      patch([{ op: "Replace", path: "active", value: "False" }]),
    ),
  /** The path-less form some tenants send for the same change. */
  deactivatePathless: (scim, id) =>
    scim.request("PATCH", `/Users/${id}`, patch([{ op: "Replace", value: { active: "False" } }])),
  reactivate: (scim, id) =>
    scim.request(
      "PATCH",
      `/Users/${id}`,
      patch([{ op: "Replace", path: "active", value: "True" }]),
    ),
  /** Hard delete (30 days after a soft delete, or the user was deleted in Entra). */
  remove: (scim, id) => scim.request("DELETE", `/Users/${id}`),
};

/**
 * Entra's create cycle: probe, look up by userName, create when absent (or reuse a match), then
 * read back by externalId. Returns `{steps, id}`; `steps` are `name=status` strings.
 */
export async function provisionUser(scim, u) {
  const steps = [];
  const probe = await entra.probe(scim);
  steps.push(`probe=${probe.status}:${probe.json?.totalResults ?? "-"}`);
  const found = await entra.findByUserName(scim, u.userName);
  steps.push(`match=${found.status}:${found.json?.totalResults ?? "-"}`);
  let id = found.json?.Resources?.[0]?.id;
  if (!id) {
    const created = await entra.create(scim, u);
    steps.push(`create=${created.status}`);
    id = created.json?.id;
  }
  const back = await entra.findByExternalId(scim, u.externalId);
  steps.push(`by_external_id=${back.status}:${back.json?.totalResults ?? "-"}`);
  return { steps, id };
}
