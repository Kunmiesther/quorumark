# SynFutures owner deployment

This release deploys the **empty account / module setup path**, not live automation.
It preserves the saved $100 allocation and 33× ceiling as a draft. It does not
change Apex/Aster configuration, paper balances, existing positions, or signatures.

## Owner flow

On Exchanges, select the verified EVM wallet in the existing SynFutures card.
Save allocation/leverage, then select **Check wallet deployment**. The server
authenticates the owner, checks the owned verified wallet and saved draft, and
reads Base. It verifies the official Safe v1.4.1 singleton, proxy factory, and
CreateCall bytecode hashes before returning an unsigned deployment review.

1. **Review account deployment in wallet** creates a deterministic, single-owner,
   threshold-one Safe on Base. Its initializer has no module, fallback handler,
   token payment, delegatecall, or worker authority.
2. After confirmation, check deployment again. **Review module deployment in
   wallet** uses the owner's Safe transaction to deploy the module with CREATE2.
   It uses a pinned CreateCall delegatecall with zero value. No token approval,
   deposit, module enable, or session configuration is included.
3. Check again to verify complete module runtime, immutable Safe references,
   Safe owner/threshold/version/singleton, and deterministic addresses.

The two transactions require **the owner's wallet confirmation and Base ETH gas**.
The backend cannot use the prevalidated owner signature: Safe requires the owner
to send the outer transaction. Never ask for a seed phrase or private key.

The browser validates the chosen account and Base network before and after
simulation, rejects failed inner Safe execution, estimates gas, and does not
automatically switch networks, sign, retry, or send. Pending submission metadata
is persisted before the wallet request. A browser lock prevents simultaneous
requests from multiple tabs. Unknown submission remains blocked pending recovery.
Refreshing checks the actual contracts, not a transaction toast or saved flag.

### Failed transaction recovery

When the saved submission includes a transaction hash, **Check wallet deployment**
also checks that transaction on Base. A retry is offered only when its finalized,
canonical receipt proves a revert and its sender, target, complete calldata,
chain and zero value match the exact deployment for this owned wallet and stage.
The owner must review and approve the retry again. No retry is automatic.
Successful outer Safe receipts without verified contracts, unfinalized receipts,
missing receipts and RPC failures remain pending. A stale browser tab cannot
clear a newer tab's pending submission. Legacy submissions without a saved hash
still require contract evidence; this release does not guess that they failed.

The unsigned session builder now requires an explicit observed module-enabled
state. Renewals skip `enableModule` when it is already enabled, revoke the old
session first, apply all market limits, and authorize the new session last.
This builder is not yet wired to an active operator or a wallet authorization UI.

### Trading-account readback and trade recovery

**Check wallet readiness** now also derives and verifies the selected owner's
deterministic Safe. Wallet USDC and wallet allowance remain funding-wallet data;
they are not used as proof of exchange collateral. The existing result note
separately reports Safe-held USDC, the Safe's Gate allowance, Gate reserve
(excluding margin already in positions), and module/session state. Reads use
the block at which deployment and ownership were verified. An undeployed Safe
is not described as funded or authorized; failed reads remain unknown, not zero.
The authenticated endpoint accepts only an owned wallet ID, never a supplied Safe.
Even an enabled unexpired session does not imply a connected execution adapter.

Receipt recovery now also checks the transaction's Base chain ID, inclusion
block and canonical `executeTrade` calldata against the journal's revision,
nonce, instrument, size, margin and reduce-only fields. Missing or mismatched
calldata cannot mark an intent filled or release its reservation on a revert.
The existing journal does not record the price tick/deadline separately: their
ABI widths are checked, while the signed transaction hash and module checks
bind/enforce those values. This is recovery hardening, not order submission.

Local verification: `vitest run src/lib/exchanges/synfutures` and
`pytest signer/tests/test_synfutures_reconciliation.py`. An opt-in read-only Base
check is in `account.live.test.ts`; it needs public owner/wallet identifiers,
not keys. These tests do not prove that live opening or closing works.

## Reproducibility

`src/lib/exchanges/synfutures/module-artifact.json` is the Solidity 0.8.30,
Cancun/optimizer-200 artifact. The contracts CI recompiles the source and compares
creation bytecode, runtime, immutable references, compiler version, and source
hash with the app artifact. Do not silently regenerate a baseline in CI.

Official deployment registry:
https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.4.1

## Still required before live trading

- Independent module security review; fork/unit tests do not constitute an audit.
- Restricted operator provisioning and owner-approved enable/session/market limits.
- Explicit collateral approval/deposit, separate from this empty deployment.
- Signing/submission adapter and exact wallet/venue route binding.
- Protective exits, renewal/expiry handling, and reconciliation scheduling.
- Included-but-not-finalized transaction handling that does not strand exits.
- End-to-end owner-approved execution/close verification.

An RPC failure or an unknown transaction must never become a "live" badge.
There are no real-money test orders in this deployment verification.
