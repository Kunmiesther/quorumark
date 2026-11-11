import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../dist/server/server.js";

const port = Number(process.env.PORT || 3000);
const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/client");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(incoming, outgoing) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(incoming.url || "/", "http://localhost").pathname);
  } catch {
    outgoing.statusCode = 400;
    outgoing.end("Bad request");
    return true;
  }
  if (pathname === "/" || pathname.endsWith("/")) return false;
  const candidate = path.resolve(staticRoot, `.${pathname}`);
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) {
    outgoing.statusCode = 403;
    outgoing.end("Forbidden");
    return true;
  }
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    outgoing.statusCode = 200;
    outgoing.setHeader("content-type", contentTypes[path.extname(candidate).toLowerCase()] || "application/octet-stream");
    outgoing.setHeader("content-length", metadata.size);
    outgoing.setHeader("cache-control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600");
    if (incoming.method === "HEAD") outgoing.end();
    else outgoing.end(await readFile(candidate));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.method === "GET" || incoming.method === "HEAD") {
      if (await serveStatic(incoming, outgoing)) return;
    }
    const host = incoming.headers.host || "127.0.0.1";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const request = new Request(`http://${host}${incoming.url || "/"}`, {
      method: incoming.method || "GET",
      headers,
      body: await readBody(incoming),
      duplex: "half",
    });
    const response = await handler.fetch(request, {}, {});
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Quorumark web request failed", error instanceof Error ? error.message : "unknown error");
    if (!outgoing.headersSent) outgoing.statusCode = 500;
    outgoing.end("Quorumark could not render this request.");
  }
});

server.on("error", (error) => {
  console.error("Quorumark web server failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Quorumark web server listening on 0.0.0.0:${port}`);
});
