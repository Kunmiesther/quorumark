// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chainRpcConfig, chainRpcTransport } from "./rpc.server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shared server-side chain RPC", () => {
  it("uses fixed public fallback only when no dedicated endpoint is configured", () => {
    vi.stubEnv("TURTLEBOT_BASE_RPC_URL", "");
    expect(chainRpcConfig("base")).toEqual({ url: "https://base-rpc.publicnode.com", dedicated: false });
  });
  it("keeps Base and BNB configuration separate", () => {
    vi.stubEnv("TURTLEBOT_BASE_RPC_URL", "https://base.example/rpc");
    vi.stubEnv("TURTLEBOT_BNB_RPC_URL", "https://bnb.example/rpc");
    expect(chainRpcConfig("base").url).toBe("https://base.example/rpc");
    expect(chainRpcConfig("bnb").url).toBe("https://bnb.example/rpc");
  });
  it.each(["http://rpc.example/secret", "file:///secret", "not-a-url-secret"])(
    "rejects invalid configuration without exposing the endpoint: %s",
    (url) => {
      vi.stubEnv("TURTLEBOT_BASE_RPC_URL", url);
      expect(() => chainRpcConfig("base")).toThrow("HTTPS is required");
      try {
        chainRpcConfig("base");
      } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    },
  );
  it("sends JSON-RPC to the dedicated endpoint without fallback", async () => {
    vi.stubEnv("TURTLEBOT_BASE_RPC_URL", "https://base.example/rpc");
    const fetcher = vi.fn(async (_input: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x2105" }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const transport = chainRpcTransport("base")({});
    expect(await transport.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(fetcher.mock.calls[0][0]).toBe("https://base.example/rpc");
  });
});
