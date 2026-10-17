"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../../lib/api/client";
import {
  listSiteAudit,
  type AuditFilters,
  type SiteAuditPage,
} from "../../../lib/admin/api/site/audit";
import { CLIENT_ERROR } from "../use-resource";

/** One filtered read of the log. `id` grows with every load; only the latest one is shown. */
export type AuditView =
  | { readonly status: "loading"; readonly id: number; readonly filters: AuditFilters }
  | {
      readonly status: "error";
      readonly id: number;
      readonly filters: AuditFilters;
      readonly error: ApiError;
    }
  | {
      readonly status: "ready";
      readonly id: number;
      readonly filters: AuditFilters;
      readonly page: SiteAuditPage;
    };

/**
 * The audit log's first page for the applied filters. Applying filters starts a new view at once
 * (status "loading", so the old rows leave the screen) and a late answer for an older view is
 * dropped, so rows of two filters never mix. Loads the unfiltered log on mount.
 */
export function useAuditView(): {
  readonly view: AuditView;
  readonly load: (filters: AuditFilters) => void;
} {
  const latest = useRef(0);
  const [view, setView] = useState<AuditView>({ status: "loading", id: 0, filters: {} });

  const load = useCallback((filters: AuditFilters) => {
    const id = ++latest.current;
    setView({ status: "loading", id, filters });
    listSiteAudit(filters).then(
      (res) => {
        if (id !== latest.current) return;
        setView(
          res.ok
            ? { status: "ready", id, filters, page: res.data }
            : { status: "error", id, filters, error: res.error },
        );
      },
      () => {
        if (id === latest.current) setView({ status: "error", id, filters, error: CLIENT_ERROR });
      },
    );
  }, []);

  useEffect(() => load({}), [load]);
  return { view, load };
}
