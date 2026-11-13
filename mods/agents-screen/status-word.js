/** Normalize hc / terminals() status to idle|working|blocked|done|error. */
export function statusWord(term) {
  if (!term) return null;
  const raw = term.status ?? term.report;
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  return raw.state ?? null;
}

export function reportedStatus(term) {
  return Boolean(term?.reported) || statusWord(term) != null;
}
