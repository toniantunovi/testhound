// How an external reference (a Jira key, a ticket URL, a doc link) is shown.
// Pasting a link is the fastest way to record a bug, but the URL itself is far
// too long for a chip or a table cell, so everything displays the short ticket
// the link points at and keeps the full value for the tooltip and the click.

/** Anything we can hand to the system browser. */
export function isReferenceUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The short label for a reference: the value itself when it is already a
 *  ticket key, and otherwise the ticket the URL points at. Jira keys win
 *  wherever they sit in the link (`/browse/AB-9222`, `?selectedIssue=AB-9222`);
 *  a numbered issue falls back to `#123`, and anything unrecognized to the last
 *  path segment or the host. */
export function referenceLabel(value: string): string {
  const raw = value.trim();
  if (!isReferenceUrl(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  const path = decode(url.pathname).replace(/\/+$/, "");
  const key = `${path} ${decode(url.search)}`.match(/[A-Za-z][A-Za-z0-9_]*-\d+/);
  if (key) return key[0];

  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return url.hostname;
  return /^\d+$/.test(last) ? `#${last}` : last;
}
