# Quorumark publication evidence contract

This narrowly scoped contract records one immutable SHA-256 commitment per
strategy/version pair. It stores no strategy parameters, backtest data, or
private creator material. A direct creator transaction records the signer as
the publication creator; proxy calls are rejected. Re-submitting the same
commitment is idempotent for that creator, while another signer or a
conflicting commitment is rejected.

Build with `cargo near build` after installing a Rust toolchain and the NEAR
CLI. Deploy it to a dedicated NEAR testnet account, initialize it with that
account, and set `VITE_NEAR_EVIDENCE_CONTRACT_ID` to the deployed account.
`owner_id` is retained as deployment metadata and exposed by a read method; the
current publication gate is the direct-signer and immutable-creator check above.
The application refuses mainnet and refuses to display confirmed evidence until
a wallet-approved function call returns a successful final outcome.
