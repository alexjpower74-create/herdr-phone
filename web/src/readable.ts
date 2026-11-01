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

// Reuse each unchanged row, including its text node, during busy screen updates.
export function patchReadable(parent: HTMLElement, lines: ReadLine[]) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tag = line.kind === "rule" ? "HR" : "DIV";
    let row = parent.children[i] as HTMLElement | undefined;
    if (!row || row.tagName !== tag) {
      const next = document.createElement(tag.toLowerCase());
      next.className = line.kind === "rule" ? "read-rule" : "read-line";
      if (row) row.replaceWith(next);
      else parent.append(next);
      row = next;
    }
    if (line.kind === "text" && row.textContent !== line.text)
      row.textContent = line.text;
  }
  while (parent.children.length > lines.length) parent.lastElementChild!.remove();
}
