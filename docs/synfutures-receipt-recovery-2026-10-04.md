# SynFutures receipt recovery — 2026-10-04

The owner funding transaction `0x1222cbd931cb4555ee303050607a403d0a74cb9ff61589c46ecf0ba322872d96` has a successful Base receipt (`status: 0x1`) at block `0x31c04a6`, block hash `0xb21796368273129cd412779d79eff62b6b130b63a1b7aec92fb99b91933019ba`. Sender is the registered owner `0x99de0b7d790e378388ff48ceee5869466aef5631`; recipient is the dedicated operator `0x09ff2902570adee0574b687bc5180bbe949d7c50`. This is operator gas funding, not a trade or completed activation.

The default `https://base-rpc.publicnode.com` endpoint returns JSON-RPC error `-32602` for this receipt: archive requests require a personal token. The activation receipt handler catches provider failures and returns `unknown`, leaving the saved owner step pending. Do not clear that pending state manually or submit the funding transaction again.

Verified that `https://mainnet.base.org` returns the successful historical receipt. Set the existing server override `TURTLEBOT_BASE_RPC_URL` to this endpoint for the project's production and preview environments. A new deployment is required to apply the override. This endpoint remains public; the override does not make it a dedicated authenticated RPC service.

After deployment, the owner must run the existing Check confirmation and continue action. Its exact sender, recipient, calldata, value and canonical-block checks remain in force. The remaining owner-reviewed collateral and Safe permissions/session steps must still be completed before Enable and verify live trading. No database trading flag was forced on, and no new transaction was submitted during recovery.
