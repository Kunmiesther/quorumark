"""Provide a minimal stub of the `apexomni` SDK when the real one is not
installed. CI installs the pinned SDK from `requirements.lock`; that path
short-circuits this stub. Local sandboxes / editors that lack the git
dependency can still collect and run the handler tests.

The stubs deliberately raise on any real use — tests must monkey-patch
`app.apex_signing.sign_order` before invoking it. The read-only tests
never call the zk signer.
"""
from __future__ import annotations

import sys
import types


def _install_apexomni_stub() -> None:
    if "apexomni" in sys.modules:
        return
    try:
        import apexomni  # noqa: F401
        return
    except Exception:
        pass

    fake = types.ModuleType("apexomni")
    zk = types.ModuleType("apexomni.zklink_sdk")

    class _Unavailable:
        def __init__(self, *a, **k):
            raise RuntimeError("apexomni stub: real SDK not installed")

        def __getattr__(self, _):
            raise RuntimeError("apexomni stub: real SDK not installed")

    for name in (
        "ZkLinkSigner", "TxSignature", "Order", "ChainId", "SubAccountId",
        "SlotId", "TokenId", "PairId", "BigUint", "Nonce", "TimeStamp",
    ):
        setattr(zk, name, _Unavailable)

    fake.zklink_sdk = zk
    sys.modules["apexomni"] = fake
    sys.modules["apexomni.zklink_sdk"] = zk


_install_apexomni_stub()
