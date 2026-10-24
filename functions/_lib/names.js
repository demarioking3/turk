/*
 * Player display names.
 * - Extra spaces trimmed and collapsed; empty names rejected.
 * - At most MAX_NAME_LENGTH characters.
 * - Letters (any language), numbers, spaces and a few safe symbols: . _ - ' ! ? & #
 *   Anything else — including < > " ` / \ and control characters — is rejected, so a name can
 *   never carry HTML or script. (The page also only ever inserts names as plain text.)
 * - Duplicate names are allowed; players are told apart by their unique player ID.
 */
export const MAX_NAME_LENGTH = 20;
const ALLOWED = /^[\p{L}\p{M}\p{N} ._\-'!?&#]+$/u;

export function cleanName(raw) {
  if (typeof raw !== "string") return { ok: false, error: "Enter your name." };
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "Enter your name." };
  if ([...name].length > MAX_NAME_LENGTH) return { ok: false, error: `Names can be up to ${MAX_NAME_LENGTH} characters.` };
  if (!ALLOWED.test(name)) return { ok: false, error: "Use letters, numbers, spaces and . _ - ' ! ? & # only." };
  return { ok: true, name };
}
