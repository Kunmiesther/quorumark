import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CONTRACT_ACCOUNT,
  EVIDENCE_CONTRACT_OWNER,
  prepareEvidenceContractDeployment,
} from "./near-evidence-contract-deployment";

describe("NEAR evidence contract deployment plan", () => {
  it("targets the existing owner account without key-management actions", () => {
    const plan = prepareEvidenceContractDeployment(new Uint8Array([0, 1, 2]));
    expect(EVIDENCE_CONTRACT_ACCOUNT).toBe("estarkunmi.testnet");
    expect(plan.signerId).toBe(EVIDENCE_CONTRACT_OWNER);
    expect(plan.receiverId).toBe(EVIDENCE_CONTRACT_OWNER);
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0].deployContract).toBeDefined();
    expect(plan.actions[1].functionCall).toBeDefined();
  });

  it("rejects a different owner", () => {
    expect(() => prepareEvidenceContractDeployment(new Uint8Array([1]), "other.testnet")).toThrow(/owner/);
  });
});
