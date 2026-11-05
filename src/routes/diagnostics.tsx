import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/diagnostics")({
  component: DiagnosticsPage,
  head: () => ({
    meta: [
      { title: "Diagnostics — Bundle Env Check" },
      { name: "description", content: "Inspect whether public backend env vars are inlined in the served bundle." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
});

type Check = {
  name: string;
  inlinedValue: string | undefined;
  present: boolean;
  masked: string;
};

function mask(v: string | undefined): string {
  if (!v) return "(missing)";
  if (v.length <= 12) return v;
  return `${v.slice(0, 8)}…${v.slice(-4)} (len=${v.length})`;
}

function buildChecks(): Check[] {
  // These references MUST be static string literals so Vite's `define`
  // replacement inlines them at build time. Do not refactor to dynamic keys.
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined;

  return [
    { name: "VITE_SUPABASE_URL", inlinedValue: url, present: !!url, masked: mask(url) },
    { name: "VITE_SUPABASE_PUBLISHABLE_KEY", inlinedValue: key, present: !!key, masked: mask(key) },
    { name: "VITE_SUPABASE_PROJECT_ID", inlinedValue: projectId, present: !!projectId, masked: mask(projectId) },
  ];
}

function DiagnosticsPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [mode, setMode] = useState<string>("");
  const [href, setHref] = useState<string>("");
  const [ua, setUa] = useState<string>("");
  const [bundleScan, setBundleScan] = useState<string>("(not run)");
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    setChecks(buildChecks());
    setMode(import.meta.env.MODE ?? "unknown");
    setHref(window.location.href);
    setUa(navigator.userAgent);
  }, []);

  const allOk = checks.length > 0 && checks.slice(0, 2).every((c) => c.present);

  async function scanBundle() {
    setScanning(true);
    setBundleScan("scanning served JS bundles…");
    try {
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))
        .map((s) => s.src)
        .filter((s) => s.includes("/assets/") || s.endsWith(".js"));

      let foundUrl = 0;
      let foundKeyPrefix = 0;
      let scanned = 0;
      const details: string[] = [];

      for (const src of scripts.slice(0, 20)) {
        try {
          const res = await fetch(src);
          const text = await res.text();
          scanned++;
          const hasSupabaseUrl = /https:\/\/[a-z0-9]+\.supabase\.co/i.test(text);
          const hasPubKey = /sb_publishable_[A-Za-z0-9_-]+/.test(text);
          if (hasSupabaseUrl) foundUrl++;
          if (hasPubKey) foundKeyPrefix++;
          if (hasSupabaseUrl || hasPubKey) {
            details.push(`${src.split("/").pop()}: url=${hasSupabaseUrl} key=${hasPubKey}`);
          }
        } catch (e) {
          details.push(`${src}: fetch failed`);
        }
      }

      setBundleScan(
        [
          `scanned ${scanned} script file(s)`,
          `chunks containing supabase URL: ${foundUrl}`,
          `chunks containing sb_publishable_ key: ${foundKeyPrefix}`,
          "",
          ...details,
        ].join("\n"),
      );
    } catch (e) {
      setBundleScan(`scan error: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground px-6 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Bundle Environment Diagnostics</h1>
          <p className="text-sm text-muted-foreground">
            Reports whether public backend variables were inlined into the JS bundle the browser is currently running.
          </p>
        </header>

        <section className="rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Overall</span>
            <span
              className={`rounded px-2 py-0.5 text-xs font-mono ${
                allOk ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
              }`}
            >
              {allOk ? "OK — required vars inlined" : "MISSING required vars"}
            </span>
          </div>
        </section>

        <section className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Variable</th>
                <th className="px-4 py-2">Inlined?</th>
                <th className="px-4 py-2">Value (masked)</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.name} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">{c.name}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-mono ${
                        c.present ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                      }`}
                    >
                      {c.present ? "yes" : "no"}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{c.masked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium">Served bundle scan</h2>
              <p className="text-xs text-muted-foreground">
                Fetches loaded JS chunks and greps for a Supabase URL and the <code>sb_publishable_</code> key prefix.
              </p>
            </div>
            <button
              onClick={scanBundle}
              disabled={scanning}
              className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
            >
              {scanning ? "Scanning…" : "Scan bundle"}
            </button>
          </div>
          <pre className="whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs font-mono">{bundleScan}</pre>
        </section>

        <section className="rounded-lg border border-border p-4 text-xs font-mono space-y-1">
          <div>mode: {mode}</div>
          <div>href: {href}</div>
          <div>ua: {ua}</div>
        </section>
      </div>
    </main>
  );
}
