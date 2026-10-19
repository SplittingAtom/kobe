import { EvalRunPage } from "../../../../../components/skills/eval-run-page";

/** One skill eval's scorecard (KOBE-328). */
export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EvalRunPage evalRunId={id} />;
}
