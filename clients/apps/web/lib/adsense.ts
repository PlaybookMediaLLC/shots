import { withoutLocale } from "@/lib/settings/appearance";
import { locales } from "@/i18n/routing";

export const ADSENSE_CLIENT = "ca-pub-8704843786311642";

// The fork serves the signed-in editor at the root, so "" (the bare locale root) is ad free too.
export const AD_FREE_ROUTES = ["", "/editor", "/code", "/tweet", "/store-screenshots"];

const AD_FREE_PATH = new RegExp(
  `^(/(${locales.join("|")}))?(${AD_FREE_ROUTES.join("|")})/?$`
);

/** True for editor workspaces, with or without a locale prefix, where ads must never appear. */
export function isAdFreePath(pathname: string): boolean {
  const path = withoutLocale(pathname);
  const platform = ['/home', '/create', '/library', '/projects', '/assets', '/canvas', '/creative-sets', '/campaigns', '/releases', '/publish', '/drafts', '/workflows', '/settings', '/activity', '/upgrade'];
  return AD_FREE_PATH.test(pathname) || platform.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
