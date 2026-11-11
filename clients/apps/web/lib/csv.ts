/** Quote one CSV cell, keeping untrusted text inert in spreadsheet applications. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value)
  // Control prefixes can hide spreadsheet formula markers.
  // eslint-disable-next-line no-control-regex
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}
