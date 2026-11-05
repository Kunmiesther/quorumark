import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  review: vi.fn(),
  finalize: vi.fn(),
  consolidate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options }));
vi.mock("@/lib/cron/authorize.server", () => ({ isAuthorizedCronRequest: mock.auth }));
vi.mock("@/lib/ai/committee/decisionEvaluate.server", () => ({ evaluateDecision: mock.review }));
vi.mock("@/lib/decision/pipelineFinalize.server", () => ({ finalizeDecision: mock.finalize }));
vi.mock("@/lib/ai/committee/consolidate.server", () => ({ consolidateDecision: mock.consolidate }));
vi.mock("@/lib/ai/committee/ledger.server", () => ({
  ledgerClient: async () => {
    const chain = {
      from: () => chain,
      select: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: mock.read,
    };
    return chain;
  },
}));
import { Route } from "../ai-advisory";
const handle = (
  Route as unknown as {
    server: { handlers: { GET: (input: { request: Request }) => Promise<Response> } };
  }
).server.handlers.GET;
const request = () =>
  handle({ request: new Request("https://example.test/api/public/hooks/ai-advisory") });
beforeEach(() => {
  vi.resetAllMocks();
  mock.auth.mockReturnValue(true);
  mock.read.mockResolvedValue({ data: [{ decision_id: "d1", user_id: "u1" }] });
  mock.review.mockResolvedValue([{ status: "evaluated" }]);
  mock.finalize.mockResolvedValue(null);
  mock.consolidate.mockResolvedValue({ created: true });
});
describe("advisory cron health", () => {
  it("requires scheduler authorization", async () => {
    mock.auth.mockReturnValue(false);
    expect((await request()).status).toBe(401);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("reports database read failure as unavailable", async () => {
    mock.read.mockResolvedValue({ error: { message: "private database details" } });
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, stage: "read" });
  });
  it.each(["review", "finalize", "consolidate"] as const)(
    "reports %s failure without dropping other stages",
    async (stage) => {
      mock[stage].mockRejectedValue(new Error("private details"));
      const response = await request();
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.failures[stage]).toBe(1);
      expect(JSON.stringify(body)).not.toContain("private details");
      expect(mock.finalize).toHaveBeenCalled();
      expect(mock.consolidate).toHaveBeenCalled();
    },
  );
  it("reports a successfully recorded provider outage separately from storage failure", async () => {
    mock.review.mockResolvedValue([{ status: "unavailable" }]);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      evaluated: 0,
      unavailable: 1,
      failures: { review: 0, finalize: 0, consolidate: 0 },
    });
  });
});
