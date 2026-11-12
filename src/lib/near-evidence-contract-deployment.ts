import { actionCreators } from "@near-wallet-selector/core";
import type { Action } from "@near-js/transactions";

export const EVIDENCE_CONTRACT_ACCOUNT = "estarkunmi.testnet";
export const EVIDENCE_CONTRACT_OWNER = "estarkunmi.testnet";
export const EVIDENCE_CONTRACT_GAS = "30000000000000";

export type PreparedNearTransaction = {
  signerId: string;
  receiverId: string;
  actions: Action[];
};

export function prepareEvidenceContractDeployment(
  wasm: Uint8Array,
  ownerId: string = EVIDENCE_CONTRACT_OWNER,
): PreparedNearTransaction {
  if (!wasm.byteLength) throw new Error("The evidence contract WASM is empty.");
  if (ownerId !== EVIDENCE_CONTRACT_OWNER) {
    throw new Error("The evidence contract owner is fixed to estarkunmi.testnet.");
  }

  return {
    signerId: EVIDENCE_CONTRACT_OWNER,
    receiverId: EVIDENCE_CONTRACT_ACCOUNT,
    actions: [
      actionCreators.deployContract(wasm),
      actionCreators.functionCall(
        "new",
        { owner_id: ownerId },
        BigInt(EVIDENCE_CONTRACT_GAS),
        BigInt(0),
      ),
    ],
  };
}
