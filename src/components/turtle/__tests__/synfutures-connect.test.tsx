import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExchangeConnectionsSheet } from "../ExchangeConnectionsSheet";

vi.mock("@/lib/venue-logos", () => ({ venueLogo: () => undefined }));
const owner = vi.hoisted(() => ({ isOwner: true, isReady: true }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/hooks/useIsOwner", () => ({ useIsOwner: () => owner }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: any) => open ? <div>{children}</div> : null,
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <h1>{children}</h1>,
  SheetDescription: ({ children }: any) => <p>{children}</p>,
}));
vi.mock("@/components/exchanges/trust/SynFuturesSdkPanel", () => ({
  SynFuturesSdkPanel: () => <div>SynFutures wallet setup and account checks</div>,
}));

afterEach(() => { cleanup(); owner.isOwner = true; owner.isReady = true; });

describe("SynFutures connection entry", () => {
  it("opens wallet setup from the picker instead of ignoring the click or asking for API keys", () => {
    render(<ExchangeConnectionsSheet open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect new exchange/i }));
    const tile = screen.getByRole("button", { name: /SynFutures/i }) as HTMLButtonElement;
    expect(tile.disabled).toBe(false);
    fireEvent.click(tile);
    expect(screen.getByText("SynFutures wallet setup and account checks")).toBeTruthy();
    expect(screen.queryByText("Connect your API keys")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Choose exchange")).toBeTruthy();
  });

  it("opens setup directly when the venue Connect action selects SynFutures", () => {
    render(<ExchangeConnectionsSheet open initialExchange="synfutures" onOpenChange={vi.fn()} />);
    expect(screen.getByText("SynFutures wallet setup and account checks")).toBeTruthy();
    expect(screen.getByText(/trading not active/i)).toBeTruthy();
  });

  it("explains unavailable access for other accounts without exposing owner setup", () => {
    owner.isOwner = false;
    render(<ExchangeConnectionsSheet open initialExchange="synfutures" onOpenChange={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("owner account");
    expect(screen.queryByText("SynFutures wallet setup and account checks")).toBeNull();
  });

  it("resets the setup screen after closing and reopening general connections", () => {
    const { rerender } = render(<ExchangeConnectionsSheet open initialExchange="synfutures" onOpenChange={vi.fn()} />);
    rerender(<ExchangeConnectionsSheet open={false} onOpenChange={vi.fn()} />);
    rerender(<ExchangeConnectionsSheet open onOpenChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Exchanges" })).toBeTruthy();
    expect(screen.queryByText("SynFutures wallet setup and account checks")).toBeNull();
  });
});
