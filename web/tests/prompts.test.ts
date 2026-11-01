import { describe, it, expect } from "vitest";
import { choices } from "../src/prompts";
const prompt =
  "Allow this operation?\n› 1. Yes\n  2. No\nPress Enter to confirm";
describe("active approval choices", () => {
  it("returns the exact numbered key and Enter", () =>
    expect(choices(prompt, "blocked")).toEqual([
      { label: "Yes", keys: ["1", "enter"] },
      { label: "No", keys: ["2", "enter"] },
    ]));
  it("ignores historical or unblocked prompts", () => {
    expect(choices(prompt + "\nOperation complete\n$ ", "blocked")).toEqual([]);
    expect(choices(prompt, "working")).toEqual([]);
  });
  it("rejects ordinary numbered lists and duplicate choices", () => {
    expect(choices("Tasks\n1. Build\n2. Test", "blocked")).toEqual([]);
    expect(choices("Allow?\n1. Yes\n1. No", "blocked")).toEqual([]);
  });
});
