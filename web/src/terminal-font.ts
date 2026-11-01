import type { Terminal } from "@xterm/xterm";
import type { ITerminalOptions } from "@xterm/xterm";

export async function terminalFontReady(options: ITerminalOptions) {
  try {
    await document.fonts.load(`${options.fontSize}px "${options.fontFamily}"`, "MWim0123456789");
  } catch {
    // A failed font request still permits the fallback display. A later successful
    // load remeasures existing terminals through the font-set listener.
  }
}

export function remeasureTerminalFont(terminal: Terminal) {
  const family = terminal.options.fontFamily;
  // Assigning the same option is a no-op in the renderer. Two equivalent font
  // stacks invalidate both its cell measurements and cached glyph widths.
  terminal.options.fontFamily = `${family}, monospace`;
  terminal.options.fontFamily = family;
  terminal.refresh(0, terminal.rows - 1);
}
