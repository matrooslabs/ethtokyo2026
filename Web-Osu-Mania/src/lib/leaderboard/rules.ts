export const DAY_SECONDS = 86400;
export const ENTRY_FEE = 1_000_000n;
export const dayOf = (timestamp: number) => Math.floor(timestamp / DAY_SECONDS);
export const endOf = (day: number) => (day + 1) * DAY_SECONDS;
export function canEnter(timestamp: number, duration: number, buffer: number) {
  return Number.isFinite(timestamp) && Number.isFinite(duration) && duration > 0 &&
    Number.isFinite(buffer) && buffer > 0 && timestamp + duration + buffer < endOf(dayOf(timestamp));
}
export function utcDate(day: number) { return new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10); }
export function dateDay(value: string) {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) throw new Error("Select a valid UTC date.");
  return dayOf(timestamp / 1000);
}
