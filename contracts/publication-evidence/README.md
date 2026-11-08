# Quorumark publication evidence contract

This narrowly scoped contract records one immutable SHA-256 commitment per
strategy/version pair. It stores no strategy parameters, backtest data, or
private creator material. Re-submitting the same commitment is idempotent;
attempting to replace it fails.

Build with `cargo near build` after installing a Rust toolchain and the NEAR
CLI. Deploy it to a dedicated NEAR testnet account, initialize it with that
account, and set `VITE_NEAR_EVIDENCE_CONTRACT_ID` to the deployed account.
The application refuses mainnet and refuses to display confirmed evidence
until a wallet-approved function call returns a successful final outcome.
