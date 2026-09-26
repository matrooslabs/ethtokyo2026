// osu! object types are bit flags (e.g. 132 is a hold starting a new combo).
export const isHoldObject = (type: number) => (type & 128) !== 0;
export function laneForX(x: number, columns: number) {
  return Math.min(columns - 1, Math.floor(x * columns / 512));
}
export function sectionLines(lines: string[], sectionName: string) {
  const header = lines.findIndex(line => line.trim() === `[${sectionName}]`);
  if (header === -1) return [];
  const remaining = lines.slice(header + 1);
  const next = remaining.findIndex(line => /^\s*\[.*\]\s*$/.test(line));
  return (next === -1 ? remaining : remaining.slice(0, next))
    .map(line => line.trim()).filter(line => line && !line.startsWith("//"));
}
