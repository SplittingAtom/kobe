"use client";

import { useState } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  addCatalogMaintainer,
  listCatalogMaintainers,
  removeCatalogMaintainer,
  type CatalogMaintainer,
} from "../../../lib/admin/api/site/catalog-maintainers";
import { listUsers, type SiteUser } from "../../../lib/admin/api/site/users";
import { Button, Field, FormRow, Select } from "../../ui/console";
import { ResourceView } from "../parts";
import { useResource, type Mutation } from "../use-resource";

interface Loaded {
  readonly maintainers: readonly CatalogMaintainer[];
  readonly users: readonly SiteUser[];
}

/**
 * A catalog skill's maintainers (KOBE-332, SK24), for Site admins: add and remove (never the
 * last; the server says so), shown inline under the skill's row.
 */
export function CatalogMaintainers({
  skill,
  mutation,
}: {
  readonly skill: { readonly id: string; readonly name: string };
  readonly mutation: Mutation;
}) {
  const { state, reload } = useResource(async (): Promise<ApiResult<Loaded>> => {
    const [maintainers, users] = await Promise.all([listCatalogMaintainers(skill.id), listUsers()]);
    if (!maintainers.ok) return maintainers;
    if (!users.ok) return users;
    return { ok: true, status: 200, data: { maintainers: maintainers.data, users: users.data } };
  });
  const [addId, setAddId] = useState("");

  async function add(users: readonly SiteUser[]) {
    const user = users.find((u) => u.id === addId);
    if (!user) return;
    const done = await mutation.run(
      () => addCatalogMaintainer(skill.id, user.id),
      () => `${user.name} now maintains ${skill.name}.`,
    );
    if (done) {
      setAddId("");
      reload();
    }
  }

  async function remove(m: CatalogMaintainer) {
    const done = await mutation.run(
      () => removeCatalogMaintainer(skill.id, m.userId),
      () => `${m.name} no longer maintains ${skill.name}.`,
    );
    if (done) reload();
  }

  return (
    <ResourceView state={state} label="maintainers">
      {({ maintainers, users }) => {
        const held = new Set(maintainers.map((m) => m.userId));
        const candidates = users.filter((u) => u.deactivatedAt === null && !held.has(u.id));
        return (
          <div
            className="flex flex-col gap-2"
            aria-label={`Maintainers of ${skill.name}`}
            role="group"
          >
            {maintainers.length === 0 ? (
              <p className="text-sm">
                No maintainer yet: the first approved submitter becomes one.
              </p>
            ) : (
              <ul>
                {maintainers.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2">
                    <span>
                      {m.name} ({m.email}){m.deactivated && " · deactivated"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={mutation.pending}
                      onClick={() => void remove(m)}
                    >
                      Remove<span className="sr-only"> {m.name}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <FormRow className="mt-0">
              <Field label="Add maintainer">
                <Select value={addId} onChange={(e) => setAddId(e.target.value)}>
                  <option value="">Choose a user…</option>
                  {candidates.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </Select>
              </Field>
              <Button disabled={mutation.pending || addId === ""} onClick={() => void add(users)}>
                Add
              </Button>
            </FormRow>
          </div>
        );
      }}
    </ResourceView>
  );
}
