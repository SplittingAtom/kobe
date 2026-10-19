/** The Workbench editor of a draft (KOBE-321); a plain module, so server code may use it too. */
export const draftHref = (id: string) => `/me/skills/drafts/${encodeURIComponent(id)}`;
