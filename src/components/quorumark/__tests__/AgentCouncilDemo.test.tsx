import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCouncilDemo } from "../AgentCouncilDemo";

describe("Quorumark simulated council", () => {
  afterEach(() => cleanup());

  it("shows the approved path and can replay the local decision", () => {
    render(<AgentCouncilDemo />);
    expect(screen.getByText("Allocate $240 to the reserve goal")).toBeInTheDocument();
    expect(screen.getByText("Approved by quorum")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(
      screen.getByText("QMR SIMULATED 0042 · policy checked before approval"),
    ).toBeInTheDocument();
  });

  it("shows a policy rejection without contacting an execution surface", () => {
    render(<AgentCouncilDemo />);
    fireEvent.click(screen.getByRole("button", { name: "Rejected path" }));
    expect(screen.getByText("Allocate $680 to the reserve goal")).toBeInTheDocument();
    expect(screen.getByText("Rejected by policy")).toBeInTheDocument();
    expect(screen.getAllByText("REJECT")).toHaveLength(2);
  });
});
