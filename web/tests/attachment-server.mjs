// Loopback-only fixture: browser multipart bytes reach a real HTTP reader.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
const root = resolve("dist");
let uploads = [];
const mime = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".html": "text/html", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const json = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
  try {
    if (req.url === "/__test/uploads") {
      if (req.method === "DELETE") uploads = [];
      return json({ uploads });
    }
    if (/^\/api\/terminals\/[^/]+\/uploads$/.test(req.url) && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Request("http://fixture.invalid", { method: "POST", headers: { "Content-Type": req.headers["content-type"] }, body: Buffer.concat(chunks) }).formData();
      const file = form.get("file");
      uploads.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()).toString("base64"), auth: req.headers.authorization, type: req.headers["content-type"] });
      res.statusCode = 201;
      return json({ upload: { id: `upload-${uploads.length}`, name: file.name, type: file.type, size: file.size, converted: false } });
    }
    const path = resolve(root, "." + (req.url === "/" ? "/index.html" : new URL(req.url, "http://fixture.invalid").pathname));
    if (!path.startsWith(root + sep)) { res.statusCode = 404; return res.end(); }
    const extension = path.slice(path.lastIndexOf("."));
    res.setHeader("Content-Type", mime[extension] || "application/octet-stream");
    res.end(await readFile(path));
  } catch {
    res.statusCode = 404; res.end();
  }
});
server.listen(5196, "127.0.0.1");
