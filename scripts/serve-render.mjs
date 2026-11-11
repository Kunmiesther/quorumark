import { createServer } from "node:http";
import handler from "../dist/server/server.js";

const port = Number(process.env.PORT || 3000);

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (incoming, outgoing) => {
  try {
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
