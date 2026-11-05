import type { Eip1193Provider } from "@/lib/wallet/providers";
import { WalletSubmissionError } from "@/lib/blockchain/walletTransaction";
import { assertDeploymentPlan, type SynDeploymentPlan } from "./deployment";

const isBase = (chain: unknown) =>
  typeof chain === "string" && /^0x[0-9a-f]+$/i.test(chain) && BigInt(chain) === 8453n;
const invalidationMessages = {
  account_changed:
    "Wallet account changed. Select the reviewed owner, then check wallet deployment again.",
  network_changed: "Wallet network changed away from Base. Check wallet deployment again on Base.",
  disconnected:
    "Wallet disconnected. Reconnect the reviewed owner, then check wallet deployment again.",
  review_closed: "Deployment review was closed or replaced. Check wallet deployment again.",
} as const;

/** Owner click only. Requests Base through the selected wallet; never auto-approves it. */
export async function submitSynDeployment(
  provider: Eip1193Provider,
  plan: SynDeploymentPlan,
  expectedOwner: string,
  beforeSend: () => void,
  stillCurrent: () => boolean = () => true,
) {
  let invalidation: keyof typeof invalidationMessages | null = null;
  let sending = false;
  const invalidate = (reason: keyof typeof invalidationMessages) => {
    if (invalidation) return;
    invalidation = reason;
    // Diagnostic codes only: never log accounts, calldata, signatures or raw wallet errors.
    console.warn("[synfutures/deployment]", {
      event: "review_invalidated",
      reason,
      stage: plan.stage,
      chainId: 8453,
    });
  };
  const matchesOwner = (accounts: unknown) =>
    Array.isArray(accounts) &&
    typeof accounts[0] === "string" &&
    accounts[0].toLowerCase() === expectedOwner.toLowerCase();
  const changedWallet = (accounts: unknown) => {
    // Providers can repeat their current state. Compare identity, not event arrival.
    if (!matchesOwner(accounts)) invalidate("account_changed");
  };
  const disconnected = () => invalidate("disconnected");
  const changedChain = (chain: unknown) => {
    // A delayed/duplicate Base event is harmless; leaving Base always invalidates,
    // even if the provider subsequently reports Base again.
    if (!isBase(chain)) invalidate("network_changed");
  };
  const checkReview = () => {
    assertDeploymentPlan(plan, expectedOwner);
    if (!stillCurrent()) invalidate("review_closed");
    if (invalidation) throw new Error(invalidationMessages[invalidation]);
  };
  const check = async (allowSwitch = false): Promise<void> => {
    checkReview();
    const accounts = await provider.request({ method: "eth_accounts" });
    const chain = await provider.request({ method: "eth_chainId" });
    if (!matchesOwner(accounts))
      throw new Error("Select the reviewed owner account in your wallet.");
    checkReview();
    if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain))
      throw new Error("Could not read your wallet network. Reconnect the selected wallet.");
    if (!isBase(chain) && allowSwitch) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x2105" }],
        });
      } catch (error) {
        if ((error as { code?: number })?.code !== 4902) throw error;
        checkReview();
        // Official Base mainnet metadata; no caller-selected RPC or chain.
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x2105",
              chainName: "Base",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://mainnet.base.org"],
              blockExplorerUrls: ["https://basescan.org"],
            },
          ],
        });
        checkReview();
        // Adding a network is not proof that the wallet switched to it.
        if (!isBase(await provider.request({ method: "eth_chainId" })))
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x2105" }],
          });
      }
      // Never trust a successful switch response without fresh account/network reads.
      await check();
      return;
    }
    if (!isBase(chain))
      throw new Error(
        "Your wallet connection did not switch to Base. Check the pending network request in your wallet, then refresh the deployment review.",
      );
  };
  provider.on?.("accountsChanged", changedWallet);
  provider.on?.("disconnect", disconnected);
  provider.on?.("chainChanged", changedChain);
  try {
    await check(true);
    const { chainId: _chainId, ...tx } = plan.transaction!;
    const simulation = await provider.request({ method: "eth_call", params: [tx, "latest"] });
    // Safe execTransaction returns bool; a successful outer call alone is insufficient.
    if (
      plan.stage === "deploy_module" &&
      (typeof simulation !== "string" || !/^0x0{63}1$/i.test(simulation))
    )
      throw new Error("Safe module deployment simulation did not succeed.");
    await provider.request({ method: "eth_estimateGas", params: [tx] });
    await check();
    beforeSend(); // Persist uncertainty before opening the wallet. Failure aborts.
    checkReview();
    sending = true;
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [plan.transaction],
    });
    if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash))
      throw new Error("No transaction hash returned.");
    return hash as `0x${string}`;
  } catch (error) {
    if (!sending && (error as { code?: number })?.code === -32002)
      throw new WalletSubmissionError(
        "A wallet request is already pending. Open your wallet and resolve it before trying again.",
        true,
      );
    if ((error as { code?: number })?.code === 4001)
      throw new WalletSubmissionError(
        "Wallet request rejected. No deployment was submitted by this request.",
        true,
      );
    throw new WalletSubmissionError(
      sending
        ? "Submission status is unknown. Check your wallet activity; do not send again."
        : error instanceof Error
          ? error.message
          : "Deployment preflight failed.",
      !sending,
    );
  } finally {
    provider.removeListener?.("accountsChanged", changedWallet);
    provider.removeListener?.("disconnect", disconnected);
    provider.removeListener?.("chainChanged", changedChain);
  }
}
