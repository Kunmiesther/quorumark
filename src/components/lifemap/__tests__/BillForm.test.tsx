import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";

const upsertMock = vi.fn(async () => ({ id: "new-bill-id" }));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => upsertMock,
}));

vi.mock("@/lib/bills/bills.functions", () => ({
  upsertBill: {},
}));

import { BillForm } from "../BillForm";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("BillForm", () => {
  beforeEach(() => {
    upsertMock.mockClear();
  });
  afterEach(() => cleanup());

  it("surfaces validation errors for empty name and zero amount", async () => {
    render(wrap(<BillForm />));
    fireEvent.click(screen.getByRole("button", { name: /add bill/i }));
    await waitFor(() => {
      expect(screen.getByText(/name required/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/must be positive/i)).toBeInTheDocument();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("submits valid values via the upsert server function", async () => {
    const onSaved = vi.fn();
    render(wrap(<BillForm onSaved={onSaved} />));
    fireEvent.change(screen.getByPlaceholderText(/rent, car payment/i), {
      target: { value: "Rent" },
    });
    const amountInput = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(amountInput, { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: /add bill/i }));

    await waitFor(() => {
      expect(upsertMock).toHaveBeenCalledTimes(1);
    });
    const call = (upsertMock.mock.calls[0] as unknown as [{ data: { name: string; amount_usd: number } }])[0];
    expect(call.data.name).toBe("Rent");
    expect(call.data.amount_usd).toBe(1500);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("new-bill-id"));
  });
});
