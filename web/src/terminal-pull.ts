/** A pull may take ownership only after native scrolling has reached its top. */
export class TerminalPull {
  private start: { id: number; x: number; y: number } | undefined;
  private distance = 0;
  private consumed = false;
  private suppressUntil = 0;
  private hint = "Earlier messages are in Conversation ↑";
  constructor(private viewport: HTMLElement, private label: HTMLElement, private enabled: () => boolean, private open: () => void) {
    viewport.addEventListener("touchstart", this.begin, { passive: true });
    viewport.addEventListener("touchmove", this.move, { passive: false });
    viewport.addEventListener("touchend", this.end, { passive: false });
    viewport.addEventListener("touchcancel", this.cancel, { passive: true });
    viewport.addEventListener("click", this.click, true);
    window.visualViewport?.addEventListener("resize", this.cancel);
    document.addEventListener("visibilitychange", this.cancel);
  }
  reset = () => {
    if (this.consumed) this.suppressUntil = performance.now() + 800;
    this.start = undefined;
    this.distance = 0;
    this.consumed = false;
    this.label.textContent = this.hint;
  };
  private cancel = () => {
    if (this.consumed) this.suppressUntil = performance.now() + 800;
    this.reset();
  };
  private valid() { return this.enabled() && !this.viewport.hidden && !document.hidden && Math.abs((window.visualViewport?.scale ?? 1) - 1) < 0.01; }
  private begin = (e: TouchEvent) => {
    this.cancel();
    if (e.touches.length !== 1 || !this.valid() || this.viewport.scrollTop > 1) return;
    const t = e.touches[0];
    this.start = { id: t.identifier, x: t.clientX, y: t.clientY };
  };
  private move = (e: TouchEvent) => {
    if (!this.start) return;
    if (e.touches.length !== 1 || !this.valid()) { this.cancel(); return; }
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - this.start.x), dy = t.clientY - this.start.y;
    if (t.identifier !== this.start.id || dy < -8 || (dx > 8 && dx > dy / 2) || this.viewport.scrollTop > 1) { this.cancel(); return; }
    if (dy < 10) { this.distance = 0; this.label.textContent = this.hint; return; }
    if (!e.cancelable) { this.cancel(); return; }
    e.preventDefault();
    this.consumed = true;
    this.distance = dy;
    this.label.textContent = "Earlier messages";
  };
  private end = (e: TouchEvent) => {
    const handoff = !!this.start && this.consumed && this.distance >= 80 && this.valid() && e.touches.length === 0;
    if (this.consumed) {
      if (e.cancelable) e.preventDefault();
      this.suppressUntil = performance.now() + 800;
    }
    this.reset();
    if (handoff) this.open();
  };
  private click = (e: MouseEvent) => {
    if (performance.now() < this.suppressUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  dispose() {
    this.cancel();
    this.viewport.removeEventListener("touchstart", this.begin);
    this.viewport.removeEventListener("touchmove", this.move);
    this.viewport.removeEventListener("touchend", this.end);
    this.viewport.removeEventListener("touchcancel", this.cancel);
    this.viewport.removeEventListener("click", this.click, true);
    window.visualViewport?.removeEventListener("resize", this.cancel);
    document.removeEventListener("visibilitychange", this.cancel);
  }
}
