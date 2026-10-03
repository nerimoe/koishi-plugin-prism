/** Parsing preserves the absolute instant; formatting preserves the API's explicit offset. */
export function parseDateTime(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function apiOffsetLabel(value: unknown): string {
  return `UTC${typeof value === "string" ? value.match(/[+-]\d{2}:\d{2}$/)?.[0] ?? "+00:00" : "+00:00"}`;
}

export function dateParts(value: unknown) {
  const date = parseDateTime(value);
  if (!date) return null;
  const text = typeof value === "string" && /[+-]\d{2}:\d{2}$/.test(value) ? value : date.toISOString();
  return { date: text.slice(0, 10), time: text.slice(11, 19) };
}
export const formatHM = (value: unknown) => dateParts(value)?.time.slice(0, 5) ?? "—";
export const formatMD = (value: unknown) => dateParts(value)?.date.slice(5) ?? "—";
export function formatDateTime(value: unknown): string {
  const parts = dateParts(value);
  return parts ? `${parts.date.replaceAll("-", "/")} ${parts.time}（${apiOffsetLabel(value)}）` : value ? "时间无效" : "永不过期";
}
