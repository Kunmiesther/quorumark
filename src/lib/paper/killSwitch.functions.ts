/**
 * Read-only status of the global paper kill switch (PAPER_ENGINE_ENABLED).
 * Diagnostics/UI only — cannot change the flag.
 */
import { createServerFn } from "@tanstack/react-start";

export const getPaperEngineFlag = createServerFn({ method: "GET" }).handler(
  async () => {
    const { isPaperEngineEnabled, paperEngineFlagRaw } = await import(
      "@/lib/paper/killSwitch"
    );
    return { enabled: isPaperEngineEnabled(), raw: paperEngineFlagRaw() };
  },
);
