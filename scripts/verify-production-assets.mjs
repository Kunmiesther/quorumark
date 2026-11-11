const origin = process.argv[2] || "http://127.0.0.1:3000";
const root = await fetch(`${origin}/`);
if (!root.ok) throw new Error(`Homepage returned HTTP ${root.status}`);
const html = await root.text();
const stylesheet = html.match(/href="(\/assets\/[^"?]+\.css(?:\?[^\"]*)?)"/)?.[1];
const script = html.match(/(?:src|href)="(\/assets\/[^"?]+\.js(?:\?[^\"]*)?)"/)?.[1];
if (!stylesheet || !script) throw new Error("The production document did not reference generated CSS and JavaScript assets");

for (const [kind, path, expected] of [["CSS", stylesheet, /text\/css/], ["JavaScript", script, /javascript/]]) {
  const response = await fetch(new URL(path, origin));
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !expected.test(contentType)) {
    throw new Error(`${kind} asset check failed: HTTP ${response.status}, ${contentType}`);
  }
  console.log(`${kind} asset OK: ${response.status} ${contentType}`);
}
