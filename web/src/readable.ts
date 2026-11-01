export type ReadLine = { kind: "text"; text: string } | { kind: "rule" };

// This presentation uses only the current screen. The original stays intact
// for the desktop mirror and all prompt decisions stay with the bridge.
export function readableLines(screen: string): ReadLine[] {
  const lines: ReadLine[] = [];
  for (let text of screen
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .split("\n")) {
    text = text.trimEnd();
    if (/^\s*[│┃║]\s*[│┃║]\s*$/.test(text)) text = "";
    if (!text) {
      const last = lines.at(-1);
      if (last && (last.kind !== "text" || last.text !== ""))
        lines.push({ kind: "text", text: "" });
    } else if (
      /^[\s\u2500-\u257f+|=_-]+$/.test(text) &&
      /[─━═╌╍┄┅┈┉=_-]{8}/.test(text)
    ) {
      lines.push({ kind: "rule" });
    } else {
      lines.push({ kind: "text", text });
    }
  }
  const last = lines.at(-1);
  if (last?.kind === "text" && !last.text) lines.pop();
  return lines;
}
