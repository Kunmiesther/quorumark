import type { Eip1193Provider } from "@/lib/wallet/providers";
import { assertPlan, type SwapPlan } from "./transactions";
import { SPOT_ROUTES } from "./spot";

export class WalletSubmissionError extends Error {
  constructor(
    message: string,
    public readonly definitelyNotSent: boolean,
  ) {
    super(message);
  }
}
export async function checkSigningWallet(provider: Eip1193Provider, plan: SwapPlan) {
  assertPlan(plan);
  const accounts = await provider.request({ method: "eth_accounts" });
  const chain = await provider.request({ method: "eth_chainId" });
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    accounts[0].toLowerCase() !== plan.owner.toLowerCase()
  )
    throw new Error("Select the reviewed wallet account in your extension, then try again.");
  if (
    typeof chain !== "string" ||
    !/^0x[0-9a-f]+$/i.test(chain) ||
    BigInt(chain) !== BigInt(plan.chainId)
  )
    throw new Error(
      `Switch your wallet to ${SPOT_ROUTES[plan.request.network].name}, then try again.`,
    );
}

/** Only called by an explicit confirmation click. No auto-switch, retry, keys or server signer. */
export async function submitReviewedTransaction(
  provider: Eip1193Provider,
  plan: SwapPlan,
  stillCurrent: () => boolean = () => true,
): Promise<`0x${string}`> {
  let requestedSignature = false;
  let changed = false;
  const onChange = () => {
    changed = true;
  };
  for (const event of ["accountsChanged", "chainChanged", "disconnect"])
    provider.on?.(event, onChange);
  try {
    if (!stillCurrent()) throw new Error("Wallet review changed. No signing request was opened.");
    await checkSigningWallet(provider, plan);
    const { chainId: _chainId, ...tx } = plan.transaction;
    await provider.request({ method: "eth_call", params: [tx, "latest"] });
    await provider.request({ method: "eth_estimateGas", params: [tx] });
    await checkSigningWallet(provider, plan);
    if (changed) throw new Error("Wallet changed during verification. Prepare a fresh review.");
    if (!stillCurrent()) throw new Error("Wallet review changed. No signing request was opened.");
    requestedSignature = true;
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [plan.transaction],
    });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
      throw new WalletSubmissionError(
        "Wallet returned no valid transaction hash. Check wallet activity before doing anything else.",
        false,
      );
    return hash.toLowerCase() as `0x${string}`;
  } catch (error) {
    if (error instanceof WalletSubmissionError) throw error;
    if ((error as { code?: number })?.code === 4001)
      throw new WalletSubmissionError(
        "You rejected the wallet request. No transaction was sent by this request.",
        true,
      );
    if (!requestedSignature)
      throw new WalletSubmissionError(
        error instanceof Error ? error.message : "Wallet preflight failed.",
        true,
      );
    throw new WalletSubmissionError(
      "Wallet submission status is unknown. Check wallet activity and recover the hash below. Do not send again.",
      false,
    );
  } finally {
    for (const event of ["accountsChanged", "chainChanged", "disconnect"])
      provider.removeListener?.(event, onChange);
  }
}
