import { z } from "zod";
import { appNameSchema, themeSettingsSchema } from "@kobe/protocol";
import { kobeTool } from "../../catalog.js";
import { changeLine, fromTo, readAs, sameValues } from "./shared.js";

/**
 * Site console › Branding and appearance (`/v1/site/branding`, `site.settings.manage`) and ›
 * Budgets (`/v1/site/budget`, `site.budgets.manage`) (KOBE-622). Logo and favicon uploads, the
 * branding reset and the other site settings (sign-in, two-factor, the Kobe MCP switch) stay in the
 * console.
 */

const BRANDING = { method: "GET", path: "/site/branding" } as const;
const brandingAnswer = z.object({
  appName: z.string(),
  showName: z.boolean(),
  logo: z.object({}).loose().nullable(),
  favicon: z.string().nullable(),
  theme: themeSettingsSchema,
  logoThemeColor: z.boolean(),
});
const brandingOut = z.strictObject({
  app_name: z.string().max(100),
  show_name: z.boolean(),
  theme: themeSettingsSchema,
  logo_theme_color: z.boolean(),
  has_logo: z.boolean(),
  has_favicon: z.boolean(),
});
const toBrandingOut = (b: z.infer<typeof brandingAnswer>) => ({
  app_name: b.appName.slice(0, 100),
  show_name: b.showName,
  theme: b.theme,
  logo_theme_color: b.logoThemeColor,
  has_logo: b.logo !== null,
  has_favicon: b.favicon !== null,
});

export const siteBrandingGet = kobeTool({
  name: "site_branding_get",
  title: "Read branding and appearance",
  description:
    "Reads the site's branding and appearance: the app name and whether it shows beside the " +
    "logo, the theme (a preset, or custom accent, corners and font), whether the logo takes the " +
    "theme colour, and whether a logo and favicon are uploaded (Site console › Branding).",
  scope: "site",
  permission: "site.settings.manage",
  readOnly: true,
  input: z.strictObject({}),
  output: brandingOut,
  route: () => BRANDING,
  reduce: (body) => toBrandingOut(brandingAnswer.parse(body)),
});

const brandingChange = fromTo({
  app_name: appNameSchema,
  show_name: z.boolean(),
  theme: themeSettingsSchema,
  logo_theme_color: z.boolean(),
});
const API_FIELD = {
  app_name: "appName",
  show_name: "showName",
  theme: "theme",
  logo_theme_color: "logoThemeColor",
} as const;
const toApi = (values: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [API_FIELD[k as keyof typeof API_FIELD], v]),
  );

export const siteBrandingSet = kobeTool({
  name: "site_branding_set",
  title: "Change branding and appearance",
  description:
    "Changes the site's app name, whether it shows beside the logo, the theme (a preset such as " +
    "default, or custom with accent, corners and font; a custom accent must reach the contrast " +
    "floor) or whether the logo takes the theme colour (Site console › Branding). Give " +
    "`change: {from, to}`: `to` holds the new values, `from` each one's current value from " +
    "site_branding_get. Every member sees the change. The person is always asked to approve; " +
    "never retry a refused or denied call.",
  scope: "site",
  permission: "site.settings.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ change: brandingChange }),
  output: brandingOut,
  route: (input) => ({
    method: "PUT",
    path: "/site/branding",
    body: { ...toApi(input.change.to), expected: toApi(input.change.from) },
  }),
  reduce: (body) => toBrandingOut(brandingAnswer.parse(body)),
  before: async (input, call) => {
    const b = await readAs(call, BRANDING, brandingAnswer);
    if (b === undefined) return "changed";
    const current = toBrandingOut(b);
    return sameValues(input.change.from, current) ? "same" : "changed";
  },
  summary: (input) =>
    `Change the site branding for everyone: ${changeLine(input.change.from, input.change.to)}`,
});

const BUDGET = { method: "GET", path: "/site/budget" } as const;
const usd = z.number().min(0).max(1_000_000_000).nullable();
const tokens = z.number().int().min(0).nullable();
const budgetFields = {
  monthly_usd: usd,
  daily_usd: usd,
  monthly_tokens: tokens,
  daily_tokens: tokens,
  user_requests_per_minute: z.number().int().min(1).max(100_000),
};
const budgetAnswer = z.object({ ...budgetFields, updated_at: z.string() });
const budgetOut = z.strictObject({ ...budgetFields, updated_at: z.string().max(40) });
const toBudgetOut = (b: z.infer<typeof budgetAnswer>) => ({
  monthly_usd: b.monthly_usd,
  daily_usd: b.daily_usd,
  monthly_tokens: b.monthly_tokens,
  daily_tokens: b.daily_tokens,
  user_requests_per_minute: b.user_requests_per_minute,
  updated_at: b.updated_at,
});

export const siteBudgetGet = kobeTool({
  name: "site_budget_get",
  title: "Read the site budget",
  description:
    "Reads the site-wide model budget: monthly and daily dollars, monthly and daily tokens (null: " +
    "no limit) and the default requests per minute per user (Site console › Budgets).",
  scope: "site",
  permission: "site.budgets.manage",
  readOnly: true,
  input: z.strictObject({}),
  output: budgetOut,
  route: () => BUDGET,
  reduce: (body) => toBudgetOut(budgetAnswer.parse(body)),
});

export const siteBudgetSet = kobeTool({
  name: "site_budget_set",
  title: "Change the site budget",
  description:
    "Changes the site-wide model budget (monthly or daily dollars or tokens; null removes that " +
    "limit) or the default requests per minute per user (Site console › Budgets); every team's " +
    "runs answer to it. Give `change: {from, to}`: `to` holds the new values, `from` each one's " +
    "current value from site_budget_get. The person is always asked to approve; never retry a " +
    "refused or denied call.",
  scope: "site",
  permission: "site.budgets.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ change: fromTo(budgetFields) }),
  output: budgetOut,
  route: (input) => ({
    method: "PUT",
    path: "/site/budget",
    body: { ...input.change.to, expected: input.change.from },
  }),
  reduce: (body) => toBudgetOut(budgetAnswer.parse(body)),
  before: async (input, call) => {
    const b = await readAs(call, BUDGET, budgetAnswer);
    return b !== undefined && sameValues(input.change.from, b) ? "same" : "changed";
  },
  summary: (input) => `Change the site budget: ${changeLine(input.change.from, input.change.to)}`,
});
