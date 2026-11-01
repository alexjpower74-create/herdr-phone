import type { Terminal, ITerminalOptions } from "@xterm/xterm";

export async function terminalFontReady(options: ITerminalOptions, loaded: () => void) {
  // Keep a stalled font server from blocking the terminal indefinitely. The
  // loadingdone listener repairs fallback measurements if the font arrives later.
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 2000);
    const finish = () => { clearTimeout(timer); resolve(); };
    document.fonts.load(`${options.fontSize}px "${options.fontFamily}"`, "MWim0123456789").then(() => {
      finish();
      // Some browser engines omit loadingdone for this load. The exact request
      // also repairs measurements when it resolves after the bounded wait.
      loaded();
    }).catch(finish);
  });
}

export function remeasureTerminalFont(terminal: Terminal) {
  const family = terminal.options.fontFamily;
  // Assigning the same option is a no-op in the renderer. Two equivalent font
  // stacks invalidate both its cell measurements and cached glyph widths.
  terminal.options.fontFamily = `${family}, monospace`;
  terminal.options.fontFamily = family;
  terminal.refresh(0, terminal.rows - 1);
}
