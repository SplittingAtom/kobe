import { Suspense } from "react";
import { AgentsPage } from "../../components/agents/agents-page";

/**
 * The Agents page (KOBE-569, AR1). The page reads `?tab=` itself (`useSearchParams`), so a link
 * to another tab works after a tab was chosen on the page; Suspense for that read.
 */
export default function Page() {
  return (
    <Suspense>
      <AgentsPage />
    </Suspense>
  );
}
