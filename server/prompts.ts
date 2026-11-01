import { createHash } from "node:crypto";
export type Prompt = {
  id: string;
  kind: "approval" | "menu";
  options: { id: string; label: string; keys: string[] }[];
};
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Parse only recognized current dialogs. Unknown screen formats keep the key bar.
export function detectPrompt(
  text: string,
  status: string,
  screenId: string,
  complete = true,
): Prompt | null {
  if (!complete || !["blocked", "idle", "done", "unknown"].includes(status))
    return null;
  const lines = text.split("\n").map((line) => line.trimEnd());
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  let kind: Prompt["kind"];
  let heading = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (
      /^\s*Would you like to run the following command\?\s*$/.test(lines[i])
    ) {
      heading = i;
      kind = "approval";
      break;
    }
    if (/^\s*Select Model and Effort\s*$/.test(lines[i])) {
      heading = i;
      kind = "menu";
      break;
    }
  }
  if (heading < 0 || (kind! === "approval" && status !== "blocked"))
    return null;
  const block = lines.slice(heading + 1);
  const options: { label: string; selected: boolean }[] = [];
  let footer = false;
  let started = false;
  for (const line of block) {
    const match = line.match(/^\s*([›❯>])?\s*(\d+)\.\s+(.+)$/);
    if (match) {
      if (footer || Number(match[2]) !== options.length + 1) return null;
      options.push({ label: match[3].trim(), selected: Boolean(match[1]) });
      started = true;
    } else if (started && line.trim()) {
      if (/^\s*Press enter to confirm or esc to cancel\s*$/i.test(line))
        footer = true;
      else if (kind! === "menu" && /^\s{3,}\S/.test(line) && !footer) {
        options.at(-1)!.label += " " + line.trim();
      } else return null;
    }
  }
  if (
    options.length < 2 ||
    options.length > 30 ||
    options.filter((o) => o.selected).length !== 1
  )
    return null;
  if (
    kind! === "approval" &&
    (!footer || !options.every((o) => /\((?:y|p|esc)\)$/.test(o.label)))
  )
    return null;
  const selected = options.findIndex((o) => o.selected);
  return {
    id: digest(screenId + ":" + kind!),
    kind: kind!,
    options: options.map((option, index) => ({
      id: digest(`${screenId}:${index}:${option.label}`).slice(0, 24),
      label: option.label,
      keys: [
        ...Array(Math.abs(index - selected)).fill(
          index < selected ? "up" : "down",
        ),
        "enter",
      ],
    })),
  };
}
