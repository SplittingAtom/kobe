"use client";

import type { PromotionPreview } from "../../lib/skills/promotions-api";
import { formatBytes } from "../../lib/files/format";

/**
 * What a promotion sends out of the team (SK19): the skill's files, its eval fixtures and whether
 * it started from a conversation; never eval transcripts or test threads. Shown before promoting
 * and on a Team admin's confirmation.
 */
export function WhatLeaves({ preview }: { readonly preview: PromotionPreview }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="m-0">
        Leaving the team: {preview.name} {preview.semver}
        {preview.newSkill ? " (a new catalog skill)" : ""}. Eval transcripts and test chats stay.
      </p>
      <p className="m-0 font-medium">Files</p>
      <ul className="m-0">
        {preview.files.map((f) => (
          <li key={f.path}>
            {f.path} ({formatBytes(f.size)})
          </li>
        ))}
      </ul>
      <p className="m-0 font-medium">Eval cases and fixtures</p>
      {preview.fixtures.length === 0 ? (
        <p className="m-0">None</p>
      ) : (
        <ul className="m-0">
          {preview.fixtures.map((f) => (
            <li key={f.path}>
              {f.path} ({formatBytes(f.size)})
            </li>
          ))}
        </ul>
      )}
      {preview.fromConversation && (
        <p className="m-0" role="note">
          Started from a conversation: what it learned there leaves with it.
        </p>
      )}
    </div>
  );
}

/** SK20's refusals, each with its reason (the version can't be promoted until they're fixed). */
export function Refusals({ preview }: { readonly preview: PromotionPreview }) {
  if (preview.refusals.length === 0) return null;
  return (
    <div role="alert" className="text-sm">
      <p className="m-0 font-medium">Not ready to promote:</p>
      <ul className="m-0">
        {preview.refusals.map((r) => (
          <li key={r.code}>{r.message}</li>
        ))}
      </ul>
    </div>
  );
}
