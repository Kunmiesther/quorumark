import { describe, expect, it } from "vitest";
import { KeyPair } from "@near-js/crypto";
import {
  EVIDENCE_CONTRACT_ACCOUNT,
  EVIDENCE_CONTRACT_OWNER,
  prepareEvidenceAccountCreation,
  prepareEvidenceContractDeployment,
  assertChildSignerCapability,
} from "./near-evidence-contract-deployment";

describe("NEAR evidence contract deployment plan", () => {
  it("creates the child with the selected wallet key and funding", () => {
    const plan = prepareEvidenceAccountCreation(
      EVIDENCE_CONTRACT_OWNER,
      EVIDENCE_CONTRACT_ACCOUNT,
      KeyPair.fromRandom("ed25519").getPublicKey().toString(),
    );
    expect(plan.signerId).toBe(EVIDENCE_CONTRACT_OWNER);
    expect(plan.receiverId).toBe(EVIDENCE_CONTRACT_ACCOUNT);
    expect(plan.actions).toHaveLength(3);
  });

  it("prepares deployment and initialization as one child-account transaction", () => {
    const plan = prepareEvidenceContractDeployment(new Uint8Array([0, 1, 2]));
    expect(plan.signerId).toBe(EVIDENCE_CONTRACT_ACCOUNT);
    expect(plan.receiverId).toBe(EVIDENCE_CONTRACT_ACCOUNT);
    expect(plan.actions).toHaveLength(2);
  });

  it("rejects wallets without multi-transaction signer support", () => {
    expect(() => assertChildSignerCapability({})).toThrow(/child-account deployment/);
    expect(() => assertChildSignerCapability({ signAndSendTransactions: () => undefined })).not.toThrow();
  });
});
