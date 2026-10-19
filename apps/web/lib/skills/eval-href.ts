/** Where one eval's full scorecard opens (KOBE-328). */
export const evalHref = (evalRunId: string) => `/me/skills/evals/${encodeURIComponent(evalRunId)}`;
