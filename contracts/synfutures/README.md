# SynFutures owner-controlled account — integration candidate

**Not deployed, audited, or enabled for production trading.** This directory is
isolated from the app's current ApeX/Aster execution paths. No production allowlist,
credentials, permissions, positions or automation rows are changed.

## Account model

- A dedicated Base Safe 1.4.1 account owns the SynFutures portfolio. The user's
  MetaMask account is its owner, not the worker.
- A separate module is bound immutably to that Safe. Owner-signed Safe calls set
  markets, operator, expiry and limits, and can revoke the session or disable the
  module. Module permissions are powerful: this custom code requires independent
  security review before any deployment is funded or enabled.
- The worker can request an immediate BTC-USDC or ETH-USDC perpetual trade only.
  It has no arbitrary-call, transfer, approval, withdrawal, delegatecall or
  owner-management method. Reductions cannot reverse a position or add margin.
- The session enforces an added-margin budget, per-trade added-margin limits,
  per-market position size/notional bounds, deposited-balance leverage bounds and
  adverse execution-price deviation from the venue's current mark. These are **not
  a maximum-loss guarantee, equity-based liquidation model or oracle-freshness
  guarantee**. Trading can lose the collateral committed to the account.
- One module per Safe isolates account permissions. RPC access and the worker's
  transaction-signing key are separate from the user's MetaMask key.

## Implemented

- Exact legacy Base Instrument/Observer ABI and trade packing; positive 18-decimal
  Instrument margin only (ERC20 USDC approval/deposit uses **6** decimals).
- Sequential intent nonces and permission revisions; changing markets, replacing
  a session or revoking it invalidates queued intents.
- Pre-execution venue checks and post-execution position/cap checks in the same
  transaction. A revert rolls back the trade, margin counter and intent nonce.
- Tests against mocks and the actual pinned Safe singleton/proxy bytecode.
- Opt-in Base fork: owner approves/deposits test USDC, worker opens/reduces/closes
  a BTC long and an ETH short held concurrently. Test-only minting and owner impersonation occur in
  the local EVM. **No broadcast or real fund movement.**
- An unsigned TypeScript setup builder in
  `src/lib/exchanges/synfutures/smartAccount.ts`. It revokes a prior session first,
  enables the module, sets selected market limits, disables unselected entries,
  and grants the new session last. Encoding alone grants no authority.

The setup builder targets a **new or currently disabled** module; re-enabling an
already enabled Safe module reverts. A future UI must read that state before
proposing the appropriate owner-signed calls. It must also verify chain, actual
Safe version/owners, reviewed deployed module bytecode and `module.safe()`.

## Reproduce

Use Foundry **1.4.4**, Solidity **0.8.30**, Node 22 and npm:

```sh
cd contracts/synfutures
npm ci --ignore-scripts --no-audit --no-fund
forge fmt --check
forge test -vv
RUN_SYNFUTURES_FORK=true BASE_FORK_RPC_URL=https://mainnet.base.org \
  forge test --match-test testBaseForkRealSafeDepositOpenReduceClose -vv
```

The fork uses the latest Base state and requires functioning public RPC. Ordinary
CI skips it; the separate workflow can run it manually without a wallet key. The
initial BTC lifecycle passed against Base block **51780751** on 2026-09-25.
The final two-market lifecycle passed at block **51781263**: 33 contract tests
passed (including two 256-run fuzz tests), alongside 37 SynFutures TypeScript
tests and the application `tsc --noEmit` check. The 0.01 ETH test entry initially
reverted with `TradeTrivial`; using 0.1 ETH met the venue minimum. Venue revert
bytes are preserved in `ExecutionFailed(bytes)` rather than silently discarded.
No full application build or remote CI result is claimed by this local check.
Passing a fork test is compatibility evidence, not a mainnet transaction receipt.

From the app root:

```sh
npm test -- src/lib/exchanges/synfutures/smartAccount.test.ts
```

## Remaining production work (do not label live-ready)

1. Independent review of the custom module and deployment artifacts; verify
   addresses/bytecode, Safe ownership and chain in setup, not merely user input.
2. Owner-reviewed MetaMask deployment, exact collateral approval/deposit, session
   authorization/revocation UX, and owner-only recovery/withdrawal path. No setup
   button should automatically sign, fund or enable the account.
3. Dedicated EVM operator signer and SynFutures broker/worker adapter. Bind every
   intent to verified user, Safe, module, market and current session revision.
4. Durable intent + EVM nonce journal, transaction simulation, gas estimates,
   bounded submission, receipt/reorg reconciliation, restart recovery and
   duplicate-submission tests. Never treat a submitted hash as a fill.
5. Protective exit policy, stale-data behavior, session-expiry alerts, open
   position reconciliation and multi-wallet monitoring. Limit orders and their
   cancellation are not implemented by this immediate-trade module.
6. End-to-end deployment/staging checks and explicit owner review of the actual
   permissions and funding before live activation. Production requires reliable
   RPC provisioning rather than assuming unlimited public RPC availability.

No changes here decide jurisdictional eligibility or promise returns.

## Official references

- [Safe modules](https://docs.safe.global/advanced/smart-account-modules)
- [Safe 1.4.1 contracts](https://github.com/safe-global/safe-smart-account/tree/v1.4.1)
- [SynFutures Base addresses](https://docs.synfutures.com/developer/smart-contract-addresses/base-network)
- [Legacy Instrument ABI](https://github.com/SynFutures/oyster-sdk/blob/main/src/abis/Instrument.json)
- [Legacy Gate ABI](https://github.com/SynFutures/oyster-sdk/blob/main/src/abis/Gate.json)
