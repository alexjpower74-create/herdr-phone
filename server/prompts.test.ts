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
test("second picker keeps default scope explicit and rejects unhandled scrolled variants", async () => {
  const text = await fixture("model-b");
  const prompt = detectPrompt(text, "idle", "model-b");
  expect(prompt?.options).toHaveLength(10);
  expect(
    prompt?.options.every((option) =>
      option.label.endsWith("default for new sessions"),
    ),
  ).toBe(true);
  expect(prompt?.options[9].keys).toEqual([...Array(9).fill("down"), "enter"]);
  expect(
    detectPrompt(text.replace("❯ 1.", "❯ 2."), "idle", "model-b"),
  ).toBeNull();
  expect(detectPrompt(text + "\nNew task ready", "idle", "model-b")).toBeNull();
  expect(
    detectPrompt(
      text.replace(
        "   Enter to set as default · s to use this session only · Esc to cancel",
        "",
      ),
      "idle",
      "model-b",
    ),
  ).toBeNull();
  expect(
    detectPrompt(
      text.replace("Enter to set as default", "Confirm"),
      "idle",
      "model-b",
    ),
  ).toBeNull();
});
test("second approval requires a current blocked command dialog and exact active footer", async () => {
  const text = await fixture("approval-b");
  const prompt = detectPrompt(text, "blocked", "approval-b");
  expect(prompt?.kind).toBe("approval");
  expect(prompt?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  expect(prompt?.options[1].keys).toEqual(["down", "enter"]);
  for (const stale of [
    text + "\nCommand complete",
    text.replace("Bash command", "Task notes"),
    text.replace("Esc to cancel · Tab to amend", ""),
  ])
    expect(detectPrompt(stale, "blocked", "approval-b")).toBeNull();
  expect(detectPrompt(text, "idle", "approval-b")).toBeNull();
});
test("model switch confirmation requires exact current cache warning and matching target", async () => {
  const text = await fixture("model-confirm-b");
  const prompt = detectPrompt(text, "done", "confirmation");
  expect(prompt?.kind).toBe("menu");
  expect(prompt?.options.map((option) => option.label)).toEqual([
    "Yes, switch to Model A (default)",
    "No, go back",
  ]);
  expect(prompt?.options[0].keys).toEqual(["enter"]);
  expect(prompt?.options[1].keys).toEqual(["down", "enter"]);
  for (const status of ["idle", "working", "blocked", "unknown"])
    expect(detectPrompt(text, status, "confirmation")).toBeNull();
  for (const stale of [
    text + "\nChanged model.",
    text.replace(
      "Your next response will be slower and use more tokens",
      "Continue?",
    ),
    text.replace(
      "This conversation is cached for the current model.",
      "An example conversation.",
    ),
    text.replace("Yes, switch to Model A", "Yes, switch to Model B"),
    text.replace("  ❯ 1.", "    1."),
    text.replace("    2.", "  ❯ 2."),
  ])
    expect(detectPrompt(stale, "done", "confirmation")).toBeNull();
  expect(detectPrompt(text, "done", "confirmation", false)).toBeNull();
});
