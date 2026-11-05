import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { hasPaperEntry } from "./paper-entry";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), oauth: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "new-test-user" }, loading: false }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signInWithOAuth: mocks.oauth } } }));
vi.mock("@/lib/onboarding-diagnostics", () => ({ useOnboardingRouteDiagnostics: vi.fn() }));
vi.mock("@/components/welcome/ProgressDots", () => ({ ProgressDots: () => null }));
import { Route } from "@/routes/welcome.index";
const Welcome = (Route as unknown as { component: ComponentType }).component;
afterEach(() => { cleanup(); sessionStorage.clear(); });

it("retains paper intent if a signed-in tester still has onboarding to finish", () => {
  render(<Welcome />);
  fireEvent.click(screen.getByRole("button", { name: /Open paper trading/ }));
  expect(hasPaperEntry()).toBe(true);
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/trade", search: { book: "paper" } });
  expect(mocks.oauth).not.toHaveBeenCalled();
});
