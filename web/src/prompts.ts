export type Choice = { label: string; keys: string[] };
// Only the active bottom prompt is actionable; earlier numbered output is history.
export function choices(text: string, status: string): Choice[] {
  if (status !== "blocked") return [];
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const tail = lines.slice(-12);
  let last = -1;
  for (let i = 0; i < tail.length; i++)
    if (/^\s*(?:[›❯>]\s*)?[1-9][.)]\s+\S/.test(tail[i])) last = i;
  if (
    last < 0 ||
    tail
      .slice(last + 1)
      .some((l) => l.trim() && !/^\s*(?:Enter|Esc|Press|Use|↑|↓|→)/i.test(l))
  )
    return [];
  let start = last;
  while (start > 0 && /^\s*(?:[›❯>]\s*)?[1-9][.)]\s+\S/.test(tail[start - 1]))
    start--;
  const heading = tail.slice(0, start).join(" ");
  if (!/(?:\?|approve|allow|proceed|continue|permission)/i.test(heading))
    return [];
  const found = tail
    .slice(start, last + 1)
    .map((line) => line.match(/^\s*(?:[›❯>]\s*)?([1-9])[.)]\s+(.{1,160})\s*$/));
  if (
    found.length < 2 ||
    found.some((m) => !m) ||
    new Set(found.map((m) => m![1])).size !== found.length
  )
    return [];
  return found.map((m) => ({ label: m![2].trim(), keys: [m![1], "enter"] }));
}
