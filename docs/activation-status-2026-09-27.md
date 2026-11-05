# Paper, blockchain and SynFutures activation status

## Verified production state

- PR #80 is published at production commit `61a522bc6ef6e18876bb5be76887eeb42e1392fd`.
- Six paper wallets were initialized once at $2,500 each. This is simulated capital,
  not authorization to deposit $15,000 of real assets. History and positions remain.
- Paper Long/Short/Hedge/Strategy routes exist. EVM and non-EVM balances are reserved;
  their strategy simulators remain unimplemented and disabled.
- Owner connection audit found verified live exchange records for ApeX and Aster,
  no SynFutures exchange record, one verified active mainnet MetaMask EVM wallet,
  and no verified active Solana wallet. Connection flags do not prove fills.

## Current local repair (not activation)

SynFutures discovery, indicative quotes and wallet preflight now use the same
server-configured `TURTLEBOT_BASE_RPC_URL` as Base spot trading. The prior code
always used the public endpoint, ignoring provisioned infrastructure. The public
fallback is paced in-process; invalid configured endpoints fail rather than
silently switching provider. Base/BNB readiness reads also honor their configured
endpoints. No endpoint secret is returned to a client. SynFutures wallet checks
require an owned, verified, active mainnet EVM wallet.

The owner-approved controls inside the existing SynFutures card save an
owner-scoped draft with allocation and maximum leverage. The new table uses
owner-only reads, server-only writes, verified mainnet EVM wallet checks and
revision-based stale-save rejection. Draft saves cannot arm routes, grant wallet
permissions or change paper balances. The UI retains the approved surface styles.
The owner has confirmed a wallet, capital allocation and leverage ceiling; those
personal values are intentionally not embedded in repository code or migrations.

## Remaining before activation

Verification of this changeset: 66 targeted tests passed locally; cloud CI passed
2,215 tests (43 skipped), application/broker typechecks, production build and the
disposable PostgreSQL security fixture. The draft migration was applied as
`20260927164603`; production RLS and policy checks passed. Publishing and signed-in
save/reload verification are the next release steps. Existing unrelated Supabase
advisories are not claimed resolved by this changeset.

1. Paper blockchain: durable quote-backed position/exit simulation and attribution
   for EVM/non-EVM, not simulated balances labeled as a working strategy.
2. SynFutures: PR #68's custom Safe module is an undeployed candidate. Independent
   review, owner deployment/authorization UI, operator adapter, nonce/intent journal,
   receipt/reorg recovery and protective exits remain. Do not merge or enable it
   as if fork-test success were a mainnet receipt.
3. Persist the confirmed choices through the authenticated card after deployment.
   Verify market-specific leverage limits, account permissions and funding before
   activation. Owner signs approvals, transfers and live activation. A saved draft
   is not evidence of any of those actions.
4. Non-EVM execution additionally needs a verified Solana address and a complete
   router/execution lifecycle. Do not infer a Solana address from an EVM wallet.

No live order, signing permission, funding transfer or production route is changed
by this repair. Passing read checks is not live execution readiness.
