import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { rememberPaperEntry, hasPaperEntry } from "./paper-entry";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  profile: vi.fn(),
  auth: { user: { id: "test-user" }, loading: false },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }) },
}));
vi.mock("@/lib/onboarding-diagnostics", () => ({ recordOnboardingDiagnostic: vi.fn() }));
vi.mock("@/components/welcome/ProgressDots", () => ({ ProgressDots: () => null }));
vi.mock("@/components/welcome/Mascot", () => ({ Mascot: () => null }));
import { Route } from "@/routes/auth.callback";
const Callback = (Route as unknown as { component: ComponentType }).component;

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.profile.mockResolvedValue({ data: { onboarding_complete_v2: true } });
});
afterEach(cleanup);
describe("paper OAuth callback routing", () => {
  it("takes an onboarded Google tester to paper, never live", async () => {
    rememberPaperEntry(true);
    render(<Callback />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/trade",
        search: { book: "paper" },
        replace: true,
      }),
    );
    expect(hasPaperEntry()).toBe(false);
  });
  it("retains paper intent while a new user completes onboarding", async () => {
    rememberPaperEntry(true);
    mocks.profile.mockResolvedValue({ data: { onboarding_complete_v2: false } });
    render(<Callback />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({ to: "/welcome/pin", replace: true }),
    );
    expect(hasPaperEntry()).toBe(true);
  });
  it("keeps ordinary sign-in routing unchanged", async () => {
    render(<Callback />);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({ to: "/home", replace: true }),
    );
  });
});
