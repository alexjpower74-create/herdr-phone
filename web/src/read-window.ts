import { patchReadable, type ReadLine } from "./readable";

// Keep the DOM bounded when the retained terminal buffer is large. Unmounted
// rows reserve estimated wrapped heights; the mounted window uses normal layout.
export class ReadWindow {
  private before?: HTMLElement;
  private content?: HTMLElement;
  private after?: HTMLElement;
  private offsets: number[] = [0];
  private source?: ReadLine[];
  private width = 0;
  private start = -1;
  private end = -1;
  render(parent: HTMLElement, lines: ReadLine[], top: number, height: number) {
    if (lines.length <= 1000) {
      if (this.content) { parent.replaceChildren(); this.clear(); }
      patchReadable(parent, lines);
      return;
    }
    if (!this.content) {
      parent.replaceChildren();
      this.before = document.createElement("div");
      this.content = document.createElement("div");
      this.after = document.createElement("div");
      this.before.setAttribute("aria-hidden", "true");
      this.after.setAttribute("aria-hidden", "true");
      parent.append(this.before, this.content, this.after);
    }
    const width = parent.clientWidth;
    if (this.source !== lines || width !== this.width) {
      this.source = lines;
      this.width = width;
      const columns = Math.max(1, Math.floor(width / 7.8));
      this.offsets = [0];
      for (const line of lines)
        this.offsets.push(this.offsets.at(-1)! + (line.kind === "rule" ? 21 :
          Math.max(1, Math.ceil(Array.from(line.text).length / columns)) * 20.15));
      this.start = this.end = -1;
    }
    top = Math.min(top, Math.max(0, this.offsets.at(-1)! - height));
    let start = 0;
    while (start < lines.length && this.offsets[start + 1] < top - 600) start++;
    let end = start;
    while (end < lines.length && this.offsets[end] < top + height + 600) end++;
    // A pathological single row still gets rendered, and a tiny viewport stays usable.
    end = Math.min(lines.length, Math.max(start + 1, end));
    if (start !== this.start || end !== this.end) {
      patchReadable(this.content!, lines.slice(start, end));
      this.start = start;
      this.end = end;
    }
    this.before!.style.height = `${this.offsets[start]}px`;
    this.after!.style.height = `${this.offsets.at(-1)! - this.offsets[end]}px`;
  }
  offset(index: number) { return this.offsets[index] ?? 0; }
  clear() {
    this.before = this.content = this.after = undefined;
    this.source = undefined;
    this.start = this.end = -1;
  }
}
