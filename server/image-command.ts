import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Failure } from "./security";

/** Support both current and legacy ImageMagick command layouts. */
export function imageCommand(operation: "convert" | "identify", args: string[]): string[] {
  const find = (name: string) => (process.env.PATH || "").split(delimiter).map(dir => join(dir, name)).find(path => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  const current = find("magick");
  if (current) return [current, ...(operation === "identify" ? ["identify"] : []), ...args];
  const legacy = find(operation);
  if (!legacy) throw new Failure(503, "conversion_unavailable", "Image conversion is unavailable.");
  return [legacy, ...args];
}
