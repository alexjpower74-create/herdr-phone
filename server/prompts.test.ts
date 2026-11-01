import { test, expect } from "bun:test";
import { detectPrompt } from "./prompts";
const fixture = (name: string) =>
  Bun.file(new URL(`fixtures/${name}.txt`, import.meta.url)).text();
test("real dialog structures preserve approval scope and wrapped menu labels", async () => {
  const approval = await fixture("approval-a");
  const prompt = detectPrompt(approval, "blocked", "screen-a");
  expect(prompt?.kind).toBe("approval");
  expect(prompt?.options[1].label).toContain(
    "don't ask again for commands that start with",
  );
  expect(prompt?.options[2].keys).toEqual(["down", "down", "enter"]);
  const model = detectPrompt(await fixture("model-a"), "idle", "screen-model");
  expect(model?.kind).toBe("menu");
  expect(model?.options).toHaveLength(3);
  expect(model?.options[0].label).toContain("coding ability.");
  expect(detectPrompt(approval, "blocked", "screen-b")?.id).not.toBe(
    prompt?.id,
  );
});
test("ordinary numbered output and historical, truncated or ambiguous dialogs yield no buttons", async () => {
  const approval = await fixture("approval-a");
  const model = await fixture("model-a");
  for (const [text, status, complete] of [
    ["1. Yes\n2. No", "blocked", true],
    [approval, "idle", true],
    [approval + "\nDone. Next message?", "blocked", true],
    [approval, "blocked", false],
    [
      approval.replace("Press enter to confirm or esc to cancel", ""),
      "blocked",
      true,
    ],
    [model + "\nPrompt ready", "idle", true],
    [model.replace("  2.", "› 2."), "idle", true],
    [model, "working", true],
  ] as const)
    expect(detectPrompt(text, status, "screen", complete)).toBeNull();
});
