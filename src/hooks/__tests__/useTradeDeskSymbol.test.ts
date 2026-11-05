import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTradeDeskSymbol } from "../useTradeDeskSymbol";

const state = vi.hoisted(() => ({
  candidateSymbol: null as string | null,
  selection: {} as { candidateId?: string; symbol?: string },
}));
vi.mock("../useCandidateLifecycle", () => ({
  useCandidateLifecycle: (selection: typeof state.selection) => {
    state.selection = selection;
    return {
      lifecycle: state.candidateSymbol ? { candidate: { symbol: state.candidateSymbol } } : null,
    };
  },
}));
afterEach(cleanup);
beforeEach(() => {
  state.candidateSymbol = null;
  state.selection = {};
});

describe("desk symbol ownership", () => {
  it("allows manual selection in a plain desk", () => {
    const { result } = renderHook(() => useTradeDeskSymbol(null, null));
    expect(result.current[0]).toBe("ETH-USDT");
    act(() => result.current[1]("BTC-USDT"));
    expect(result.current[0]).toBe("BTC-USDT");
    expect(state.selection).toEqual({ symbol: "BTC-USDT" });
  });

  it("a candidate seeds the symbol but cannot override subsequent user selection", () => {
    state.candidateSymbol = "BTC-USDT";
    const { result, rerender } = renderHook(({ id }) => useTradeDeskSymbol(null, id), {
      initialProps: { id: "first" },
    });
    expect(result.current[0]).toBe("BTC-USDT");
    act(() => result.current[1]("SOL-USDT"));
    rerender({ id: "first" });
    expect(result.current[0]).toBe("SOL-USDT");
    expect(state.selection).toEqual({ symbol: "SOL-USDT" });
    state.candidateSymbol = "XRP-USDT";
    rerender({ id: "second" });
    expect(result.current[0]).toBe("XRP-USDT");
  });

  it("ignores a late candidate response after the user changes symbol", () => {
    const { result, rerender } = renderHook(() => useTradeDeskSymbol(null, "pending"));
    act(() => result.current[1]("SOL-USDT"));
    state.candidateSymbol = "BTC-USDT";
    rerender();
    expect(result.current[0]).toBe("SOL-USDT");
  });
});
