import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SynFuturesSdkPanel } from "../trust/SynFuturesSdkPanel";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("../trust/SynFuturesAccountSetup", () => ({ SynFuturesAccountSetup: () => null }));
vi.mock("@/lib/exchanges/synfutures.functions", () => ({
  inspectSynFuturesSdk: vi.fn(),
  inspectSynFuturesWallet: vi.fn(),
}));
const choices = vi.hoisted(() => ({ single: false }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [{ id: "wallet", provider: "metamask", label: null,
      public_address: "0x123456789012345678901234567890123456abcd",
      status: "verified", is_active: true }, ...(choices.single ? [] : [{ id: "wallet-two", provider: "metamask", label: null,
      public_address: "0x223456789012345678901234567890123456abcd", status: "verified", is_active: true }])],
    isLoading: false, isError: false,
  }),
  useMutation: () => ({ reset: vi.fn(), mutate: vi.fn(), isPending: false }),
}));

afterEach(() => { cleanup(); choices.single = false; });

describe("SynFutures responsive wallet selectors", () => {
  it("selects the only verified wallet so Connect can proceed without repeating selection", () => {
    choices.single = true;
    render(<SynFuturesSdkPanel />);
    expect((screen.getByLabelText("Verified wallet") as HTMLSelectElement).value).toBe("wallet");
    expect((screen.getByRole("button", { name: "Check wallet readiness" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("associates each label with its own panel and keeps selections independent", () => {
    render(<><SynFuturesSdkPanel /><SynFuturesSdkPanel /></>);
    const selectors = screen.getAllByLabelText("Verified wallet") as HTMLSelectElement[];
    expect(selectors).toHaveLength(2);
    expect(selectors[0].id).not.toBe(selectors[1].id);
    const buttons = screen.getAllByRole("button", { name: "Check wallet readiness" }) as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    fireEvent.change(selectors[1], { target: { value: "wallet" } });
    expect(selectors[0].value).toBe("");
    expect(selectors[1].value).toBe("wallet");
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
  });
});
