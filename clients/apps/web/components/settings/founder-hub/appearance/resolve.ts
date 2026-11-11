// Ported from apps/desktop/src/shared/theme/resolve.ts; see dev/import-founder-hub-ui.mjs.
export type ThemePreference = 'light' | 'dark' | 'system'

export function resolveIsDarkMode(theme: ThemePreference, prefersDark: boolean): boolean {
  if (theme === 'dark') {
    return true
  }
  if (theme === 'light') {
    return false
  }
  return prefersDark
}
