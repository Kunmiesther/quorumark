import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { toNearWalletNonce } from "@/lib/wallet/near-nonce";

import "@near-wallet-selector/modal-ui/styles.css";

let selectorPromise: Promise<WalletSelector> | undefined;
let modal: ReturnType<typeof setupModal> | undefined;

function quorumarkIconUrl() {
  return typeof window === "undefined"
    ? "https://quorumark-web.onrender.com/favicon.svg"
    : `${window.location.origin}/favicon.svg`;
}

export async function getNearSelector(): Promise<WalletSelector> {
  if (!selectorPromise) {
    selectorPromise = setupWalletSelector({
      network: "testnet",
      optimizeWalletOrder: true,
      modules: [
        setupMeteorWallet({ iconUrl: quorumarkIconUrl() }),
        setupMyNearWallet({ walletUrl: "https://testnet.mynearwallet.com", iconUrl: quorumarkIconUrl() }),
      ],
    });
  }
  return selectorPromise;
}

export async function showNearWalletSelector(): Promise<string> {
  const selector = await getNearSelector();
  const current = selector.store.getState().accounts?.[0]?.accountId;
  if (current) return current;
  modal ??= setupModal(selector, {
    theme: "dark",
    description: "Choose a NEAR wallet to authenticate with Quorumark.",
  });
  return new Promise((resolve, reject) => {
    let subscription: { remove: () => void } | undefined;
    const timeout = window.setTimeout(() => {
      subscription?.remove();
      reject(new Error("NEAR wallet selection timed out."));
    }, 120_000);
    subscription = selector.on("signedIn", ({ accounts }) => {
      window.clearTimeout(timeout);
      subscription?.remove();
      const account = accounts[0]?.accountId;
      if (account) resolve(account);
      else reject(new Error("NEAR wallet did not return an account."));
    });
    modal?.show();
  });
}

export async function getSelectedNearWalletId(): Promise<string | null> {
  const selector = await getNearSelector();
  return selector.store.getState().selectedWalletId;
}

export async function signNearChallenge(message: string, nonceValue: string, challengeRecipient: string) {
  const selector = await getNearSelector();
  const state = selector.store.getState();
  const account = state.accounts?.[0];
  if (!account) throw new Error("Choose a NEAR wallet before signing in.");
  const wallet = await selector.wallet();
  if (!wallet.signMessage) throw new Error("The selected NEAR wallet does not support message signing.");
  const recipient = challengeRecipient.trim();
  if (!recipient) throw new Error("NEAR authentication challenge has no recipient.");
  const signed = await wallet.signMessage({
    message,
    recipient,
    nonce: toNearWalletNonce(nonceValue),
  });
  if (!signed) throw new Error("The NEAR wallet did not return a signature.");
  return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
}

export async function signOutNear() {
  const selector = await getNearSelector();
  const wallet = await selector.wallet();
  await wallet.signOut();
}
