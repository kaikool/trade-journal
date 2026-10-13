/** Quote CSV syntax and stop spreadsheet apps interpreting untrusted text as formulas. */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (typeof value !== "number" && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
