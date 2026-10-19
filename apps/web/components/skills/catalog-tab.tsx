"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  CATALOG_SORTS,
  listCatalog,
  type CatalogCard,
  type CatalogFilter,
  type CatalogSort,
} from "../../lib/skills/catalog-api";
import { Badge, Button, EmptyState, Field, FormRow, Select, TextInput } from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";

export const catalogHref = (id: string) => `/me/skills/catalog/${encodeURIComponent(id)}`;

const SORT_LABELS: Readonly<Record<CatalogSort, string>> = {
  name: "Name",
  updated: "Recently updated",
  teams: "Teams installed",
};

const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)}%`);

/** The card's state in this team (SK25): installed, added by me, blocked. */
export function TeamStateBadges({ card }: { readonly card: CatalogCard }) {
  const s = card.state;
  return (
    <>
      {s.installed && (
        <Badge tone="done">Installed{s.installed.semver ? ` ${s.installed.semver}` : ""}</Badge>
      )}
      {s.addedByMe && <Badge tone="running">Added by me</Badge>}
      {s.blocked && <Badge tone="failed">Blocked in this team</Badge>}
      {card.status === "deprecated" && <Badge tone="attention">Deprecated</Badge>}
      {card.status === "unmaintained" && <Badge tone="attention">Unmaintained</Badge>}
    </>
  );
}

function Card({ card }: { readonly card: CatalogCard }) {
  const pass = pct(card.score?.passRate ?? null);
  return (
    <li className="rounded-md border border-console-border p-3">
      <h3 className="m-0 text-base font-medium">
        <Link href={catalogHref(card.id)} className="underline">
          {card.name}
        </Link>{" "}
        <span className="text-console-muted">{card.latest.semver}</span>
      </h3>
      <p className="mt-1 mb-2">{card.summary}</p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-console-muted">
          {card.publisher === "kobe" ? "By Kobe" : "By its maintainers"}
        </span>
        <Badge tone={card.latest.verdict === "pass" ? "done" : "attention"}>
          scan: {card.latest.verdict}
        </Badge>
        {pass && <span>passes {pass} of its evals</span>}
        <span className="text-console-muted">
          {card.teamsInstalled === "few"
            ? "a few teams"
            : `${card.teamsInstalled} ${card.teamsInstalled === 1 ? "team" : "teams"}`}
        </span>
        {card.topics.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        <TeamStateBadges card={card} />
      </div>
    </li>
  );
}

/**
 * The Catalog tab (KOBE-336, SK25): the Site's catalog skills as seen from this team, searched
 * with Postgres full-text search, filtered by a topic tag and sorted by name, recently updated or
 * teams installed; each opens its detail.
 */
export function CatalogTab() {
  const teamId = useTeamAccess().team.id;
  const [filter, setFilter] = useState<CatalogFilter>({ q: "", tag: null, sort: "name" });
  const [text, setText] = useState("");
  const search = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFilter({ ...filter, q: text });
  };
  return (
    <>
      <form role="search" aria-label="Search the catalog" onSubmit={search}>
        <FormRow>
          <Field label="Search">
            <TextInput
              type="search"
              maxLength={200}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <Button type="submit">Search</Button>
        </FormRow>
      </form>
      <CatalogList
        key={JSON.stringify(filter)}
        teamId={teamId}
        filter={filter}
        onFilter={setFilter}
      />
    </>
  );
}

function CatalogList({
  teamId,
  filter,
  onFilter,
}: {
  readonly teamId: string;
  readonly filter: CatalogFilter;
  readonly onFilter: (f: CatalogFilter) => void;
}) {
  const { state } = useResource(() => listCatalog(teamId, filter));
  return (
    <ResourceView state={state} label="the catalog">
      {({ skills, tags }) => (
        <>
          <FormRow>
            <Field label="Topic">
              <Select
                value={filter.tag ?? ""}
                onChange={(e) => onFilter({ ...filter, tag: e.target.value || null })}
              >
                <option value="">All topics</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sort by">
              <Select
                value={filter.sort}
                onChange={(e) => onFilter({ ...filter, sort: e.target.value as CatalogSort })}
              >
                {CATALOG_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          {skills.length === 0 ? (
            <EmptyState title="No catalog skill matches." />
          ) : (
            <ul className="mt-3 grid list-none gap-3 ps-0">
              {skills.map((s) => (
                <Card key={s.id} card={s} />
              ))}
            </ul>
          )}
        </>
      )}
    </ResourceView>
  );
}
