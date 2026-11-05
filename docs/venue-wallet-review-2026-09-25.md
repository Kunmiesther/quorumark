# Wallet identity, venue evidence and SynFutures readiness

## Changes

- Exchange cards and live position views match an owned verified wallet to each exchange's recorded public account address, case-insensitively. One wallet can match several exchanges. This does not write funding assignments or change signing credentials.
- The `wallet_identities` read action requires the signed-in owner. ApeX uses the active account's public wallet address; Aster reads only its public master-address credential slot, never its agent private key. Missing/mismatching identity is not guessed from the number of wallets.
- Live Council/advisory snapshots resolve the venue from the position's connection. Aster uses its own 5m/1h/4h public candles; higher-timeframe caches are separated by venue. ApeX environment frames are never substituted for Aster.
- Council market-close payloads retain that venue. Aster resting-limit TP requests are explicitly reported as unsupported by the current broker, rather than sent with ApeX rules. No order is submitted by the tests or diagnostics.
- SynFutures can check an owned verified wallet's Base ETH balance and discovered quote-token balances/allowances. Reads are chain-checked and token targets come only from the verified registry. Failed reads remain unknown, not zero. No signing, approval, transfer or wallet connection is performed.
- Lower Trade analytics retain the neumorphic surfaces, adding semantic P&L colors, section accents, pair logos and labeled observed win-rate bars. Calculations and trade samples are unchanged.

## Still incomplete

- Council provider credits must be available before every configured seat can respond.
- Aster native daily/weekly/monthly environment evidence is not yet wired into this snapshot reader; it is explicitly unavailable.
- Aster resting-limit Council take-profits are not supported by the current broker. Market exits have a venue-specific route, but this release does not perform a live transaction test.
- SynFutures execution is not ready: signing/delegation, collateral actions, order lifecycle, close/cancel, reconciliation and full execution tests remain. SDK/registry success or positive wallet balances must never be called live readiness.

## Owner verification

1. Exchanges: check each exchange's MetaMask address against the intended account.
2. Exchanges → SynFutures setup: select a verified wallet and run **Check wallet readiness**. Review Base gas and the exact quote-token balance; these are wallet assets, not exchange collateral.
3. Trade → Performance, risk & missed setups: review the compact color-coded metrics and pair marks; switch book to confirm separation.
4. After provider credits are restored, inspect the next recorded Council review for seat availability and `market_data_exchange`. Do not call an execution sweep merely to test the display.
