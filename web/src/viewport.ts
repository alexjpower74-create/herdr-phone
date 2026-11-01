/** Keep the app inside the keyboard's visible area without changing pinch zoom. */
export function trackViewport(app: HTMLElement): () => void {
  const viewport = window.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    // A pinch changes the visual area without opening a keyboard. Leave the
    // layout in place so the browser can zoom and pan the terminal naturally.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport?.height ?? window.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(top)) return;
    app.style.setProperty("--app-height", `${height}px`);
    app.style.setProperty("--app-top", `${Math.max(0, top)}px`);
    app.dataset.keyboardOpen = String(height < window.innerHeight - 80);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", schedule);
  update();
  return () => {
    cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("pageshow", schedule);
  };
}
