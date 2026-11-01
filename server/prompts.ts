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
  let family: "a" | "b" | "confirmation" = "a";
  let confirmationModel = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Switch model\?\s*$/.test(lines[i]) && status === "done") {
      const remainder = lines.slice(i + 1);
      const firstOption = remainder.findIndex((line) =>
        /^\s*([›❯>])?\s*1\.\s/.test(line),
      );
      if (firstOption < 0) return null;
      const paragraphs = remainder
        .slice(0, firstOption)
        .join("\n")
        .trim()
        .split(/\n\s*\n/)
        .map((paragraph) =>
          paragraph
            .split("\n")
            .map((line) => line.trim())
            .join(" "),
        );
      const content = [
        ...paragraphs,
        ...remainder
          .slice(firstOption)
          .map((line) => line.trim())
          .filter(Boolean),
      ];
      const cached = content[1]?.match(
        /^This conversation is cached for the current model\. Switching to (.+) means the full history gets re-read\.$/,
      );
      if (
        content.length !== 4 ||
        content[0] !==
          "Your next response will be slower and use more tokens" ||
        !cached
      )
        return null;
      confirmationModel = cached[1];
      heading = i;
      kind = "menu";
      family = "confirmation";
      break;
    }

    if (
      /^\s*Would you like to run the following command\?\s*$/.test(lines[i])
    ) {
      heading = i;
      kind = "approval";
      break;
    }
    if (
      /^\s*Do you want to proceed\?\s*$/.test(lines[i]) &&
      lines.slice(0, i).some((line) => /^\s*Bash command\s*$/.test(line))
    ) {
      heading = i;
      kind = "approval";
      family = "b";
      break;
    }
    if (/^\s*Select model\s*$/.test(lines[i])) {
      heading = i;
      kind = "menu";
      family = "b";
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
  let block = lines.slice(heading + 1);
  if (family === "b" && kind! === "menu") {
    const footerStart = block.findIndex((line) =>
      /^\s*Enter to set as default/.test(line),
    );
    const expected =
      "Enter to set as default · s to use this session only · Esc to cancel";
    if (
      footerStart >= 0 &&
      block
        .slice(footerStart)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ") === expected
    )
      block = [...block.slice(0, footerStart), expected];
  }
  const options: { label: string; selected: boolean }[] = [];
  let footer = false;
  let started = false;
  let continuationColumn: number | undefined;
  for (const line of block) {
    const match = line.match(/^\s*([›❯>↓])?\s*(\d+)\.\s+(.+)$/);
    if (match) {
      if (footer || Number(match[2]) !== options.length + 1) return null;
      options.push({
        label: match[3].trim(),
        selected: Boolean(match[1] && match[1] !== "↓"),
      });
      started = true;
      const description = match[3].match(/ {2,}(\S.*)$/);
      continuationColumn = description
        ? line.length - description[1].length
        : undefined;
    } else if (started && line.trim()) {
      if (
        family === "b" &&
        kind! === "menu" &&
        !footer &&
        continuationColumn !== undefined &&
        line.search(/\S/) === continuationColumn
      ) {
        options.at(-1)!.label += " " + line.trim();
      } else if (/^\s*Press enter to confirm or esc to cancel\s*$/i.test(line))
        footer = true;
      else if (
        family === "b" &&
        kind! === "approval" &&
        /^\s*Esc to cancel · Tab to amend\s*$/.test(line)
      )
        footer = true;
      else if (
        family === "b" &&
        /^\s*Enter to set as default · s to use this session only · Esc to cancel\s*$/.test(
          line,
        )
      )
        footer = true;
      else if (
        family === "b" &&
        !footer &&
        (/^\s*… \+\d+ models\s*$/.test(line) ||
          /^\s*◐ .+ effort \(default\) ←\/→ to adjust\s*$/.test(line))
      ) {
        continuationColumn = undefined;
      } else if (
        family === "a" &&
        kind! === "menu" &&
        /^\s{3,}\S/.test(line) &&
        !footer
      ) {
        options.at(-1)!.label += " " + line.trim();
      } else return null;
    } else if (!line.trim()) {
      continuationColumn = undefined;
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
    family === "a" &&
    (!footer || !options.every((o) => /\((?:y|p|esc)\)$/.test(o.label)))
  )
    return null;
  if (family === "b" && !footer) return null;
  if (
    family === "confirmation" &&
    (options.length !== 2 ||
      options[0].label !== `Yes, switch to ${confirmationModel}` ||
      options[1].label !== "No, go back")
  )
    return null;

  const selected = options.findIndex((o) => o.selected);
  return {
    id: digest(screenId + ":" + kind!),
    kind: kind!,
    options: options.map((option, index) => ({
      id: digest(`${screenId}:${index}:${option.label}`).slice(0, 24),
      label:
        family === "b" && kind! === "menu"
          ? `${option.label} — default for new sessions`
          : option.label,
      keys: [
        ...Array(Math.abs(index - selected)).fill(
          index < selected ? "up" : "down",
        ),
        "enter",
      ],
    })),
  };
}
