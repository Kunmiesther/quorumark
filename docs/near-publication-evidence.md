# NEAR testnet publication evidence

Publication evidence is optional and testnet-only. The application hashes a
canonical, domain-separated record for one immutable strategy version and
stores that commitment in Supabase. It then asks the selected NEAR wallet to
approve one `record_publication` function call. The backend verifies the
finalized RPC result, signer, receiver, and function arguments before marking
the record `confirmed`.

Before enabling the button, deploy `contracts/publication-evidence` to a
dedicated NEAR testnet account, initialize it, and configure both
`VITE_NEAR_EVIDENCE_CONTRACT_ID` and the server-only
`QUORUMARK_NEAR_EVIDENCE_CONTRACT_ID`. Never use a mainnet contract or store
strategy parameters on-chain.

Without that deployed contract, Quorumark deliberately reports evidence as
unavailable; it never invents a transaction hash or treats a local digest as
on-chain proof.
