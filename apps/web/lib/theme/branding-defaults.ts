import {
  DEFAULT_APP_NAME,
  DEFAULT_SHOW_NAME,
  DEFAULT_THEME,
  type SiteBranding,
} from "@kobe/protocol";

/**
 * The built-in branding (theming plan §4.3): what every page shows with nothing configured, or
 * when the server cannot be reached. Plain data, safe for client and server modules alike.
 */
export const DEFAULT_BRANDING: SiteBranding = Object.freeze({
  appName: DEFAULT_APP_NAME,
  showName: DEFAULT_SHOW_NAME,
  logo: null,
  favicon: null,
  theme: DEFAULT_THEME,
});
