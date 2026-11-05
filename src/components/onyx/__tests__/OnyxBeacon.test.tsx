import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OnyxBeacon } from "../OnyxBeacon";



const openOnyxMock = vi.fn();
vi.mock("@/components/onyx/OnyxPanel", () => ({
  openOnyx: () => openOnyxMock(),
  useOnyxOpen: () => false,
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, isReady: true }),
}));
vi.mock("@/assets/onyx-head.png.asset.json", () => ({
  default: { url: "/onyx.png" },
}));

describe("OnyxBeacon", () => {
  beforeEach(() => openOnyxMock.mockReset());
  afterEach(() => cleanup());


  it("renders ONYX label and opens panel on click", () => {
    render(<OnyxBeacon />);
    const btn = screen.getByTestId("onyx-beacon");
    expect(btn).toHaveTextContent("ONYX");
    expect(btn).not.toHaveTextContent("Ask");
    fireEvent.click(btn);
    expect(openOnyxMock).toHaveBeenCalledOnce();
  });

  it("reflects status via data-onyx-status and aria-label", () => {
    render(<OnyxBeacon statusOverride="thinking" />);
    const btn = screen.getByTestId("onyx-beacon");
    expect(btn.getAttribute("data-onyx-status")).toBe("thinking");
    expect(btn.getAttribute("aria-label")).toMatch(/thinking/);
  });

  it("offline status disables ring animation", () => {
    render(<OnyxBeacon statusOverride="offline" />);
    const btn = screen.getByTestId("onyx-beacon");
    expect(btn.getAttribute("data-onyx-status")).toBe("offline");
    // no animation style when offline
    expect(btn.style.animation || "").toBe("");
  });

  it("degraded status advertises degraded", () => {
    render(<OnyxBeacon statusOverride="degraded" />);
    expect(screen.getByTestId("onyx-beacon").getAttribute("aria-label")).toMatch(/degraded/);
  });

  it("fab variant hides text label but keeps aria", () => {
    render(<OnyxBeacon variant="fab" />);
    const btn = screen.getByTestId("onyx-beacon");
    expect(btn).not.toHaveTextContent("ONYX");
    expect(btn.getAttribute("aria-label")).toMatch(/Open Onyx/);
  });

  it("beacon and ring never use a rotate transform animation", async () => {
    // Regression: the traveling highlight must be a stroke-dashoffset tracer,
    // never a rotating capsule. No keyframe rotate() and no transform on the
    // beacon container or its ring / rect elements.
    const cssModule: { default: string } = await import("@/styles.css?raw");
    const css = cssModule.default;
    expect(css).not.toMatch(/@keyframes\s+onyx-beacon-spin/);
    expect(css).not.toMatch(/onyx-beacon[^{]*\{[^}]*transform:\s*rotate/i);

    render(<OnyxBeacon statusOverride="ready" />);
    const btn = screen.getByTestId("onyx-beacon");
    expect(btn.style.transform || "").not.toMatch(/rotate/);
    expect(btn.style.animationName || "").not.toMatch(/spin|rotate/i);
    const rects = btn.querySelectorAll("svg rect");
    rects.forEach((rect) => {
      const s = (rect as SVGRectElement).getAttribute("style") || "";
      expect(s).not.toMatch(/rotate/i);
      expect(s).not.toMatch(/animation:[^;]*(spin|rotate)/i);
    });
  });
});
