import { actionCreators } from "@near-wallet-selector/core";
import { PublicKey } from "@near-js/crypto";

export const EVIDENCE_CONTRACT_ACCOUNT = "evidence.estarkunmi.testnet";
export const EVIDENCE_CONTRACT_OWNER = "estarkunmi.testnet";
export const EVIDENCE_CONTRACT_FUNDING_YOCTO = BigInt("1800000000000000000000000");
export const EVIDENCE_CONTRACT_GAS = "30000000000000";

export type PreparedNearTransaction = {
  signerId: string;
  receiverId: string;
  actions: unknown[];
};

/**
 * Creates the first transaction in the guarded deployment flow. The selected
 * wallet public key is added to the new account; no private key is generated,
 * exported, or stored by Quorumark.
 */
export function prepareEvidenceAccountCreation(
  parentAccountId: string,
  childAccountId: string = EVIDENCE_CONTRACT_ACCOUNT,
  selectedWalletPublicKey: string,
): PreparedNearTransaction {
  if (parentAccountId !== EVIDENCE_CONTRACT_OWNER) {
    throw new Error("The connected wallet must be estarkunmi.testnet.");
  }
  if (childAccountId !== EVIDENCE_CONTRACT_ACCOUNT) {
    throw new Error("The evidence account target is fixed for this deployment.");
  }
  if (!selectedWalletPublicKey.trim()) {
    throw new Error("The wallet did not provide a public key for the new account.");
  }

  return {
    signerId: parentAccountId,
    receiverId: childAccountId,
    actions: [
      actionCreators.createAccount(),
      actionCreators.addKey(PublicKey.from(selectedWalletPublicKey), actionCreators.fullAccessKey()),
      actionCreators.transfer(EVIDENCE_CONTRACT_FUNDING_YOCTO),
    ],
  };
}

/**
 * Creates the second transaction. It must be signed by the new child account,
 * using the FullAccess key added by prepareEvidenceAccountCreation.
 */
export function prepareEvidenceContractDeployment(
  wasm: Uint8Array,
  ownerId: string = EVIDENCE_CONTRACT_OWNER,
): PreparedNearTransaction {
  if (!wasm.byteLength) throw new Error("The evidence contract WASM is empty.");
  if (ownerId !== EVIDENCE_CONTRACT_OWNER) {
    throw new Error("The evidence contract owner is fixed to estarkunmi.testnet.");
  }

  return {
    signerId: EVIDENCE_CONTRACT_ACCOUNT,
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

export function assertChildSignerCapability(wallet: { signAndSendTransactions?: unknown }): void {
  if (typeof wallet.signAndSendTransactions !== "function") {
    throw new Error("This wallet cannot sign the child-account deployment transaction safely.");
  }
}
