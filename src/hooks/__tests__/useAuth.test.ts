import { describe, expect, it, vi } from "vitest";
import { withAuthRestoreTimeout } from "@/hooks/useAuth";

describe("withAuthRestoreTimeout", () => {
  it("returns a stored session result when it resolves", async () => {
    const result = await withAuthRestoreTimeout(Promise.resolve({ session: "ready" }), 100);

    expect(result).toEqual({ session: "ready" });
  });

  it("rejects when session storage never responds", async () => {
    vi.useFakeTimers();
    try {
      const pending = withAuthRestoreTimeout(new Promise<never>(() => undefined), 100);
      const assertion = expect(pending).rejects.toThrow("Stored session restore timed out");

      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
