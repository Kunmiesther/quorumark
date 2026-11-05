"""ApeX Omni internal-capital adapter.

The only write operations in this module move USDT between the Funding and
Perps ledgers of the same ApeX account. No external address, chain id, or
withdrawal method is accepted or called.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from .apex_sdk_order import _env_constants
from .orders_v3 import OrderRestError, RestCreds


def _payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    data = value.get("data")
    return data if isinstance(data, dict) else value


def _decimal_text(value: Any) -> str:
    try:
        number = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError):
        return "0"
    if not number.is_finite() or number < 0:
        return "0"
    return format(number, "f")


def _first(obj: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = obj.get(key)
        if value not in (None, ""):
            return value
    return None


def _ledger(account: dict[str, Any], name: str) -> dict[str, str]:
    row = account.get(name)
    row = row if isinstance(row, dict) else {}
    return {
        "available": _decimal_text(
            _first(row, "availableBalance", "available", "free", "withdrawable")
        ),
        "total": _decimal_text(
            _first(
                row,
                "totalBalance",
                "totalWalletBalance",
                "totalEquityValue",
                "totalEquity",
                "equity",
                "balance",
                "walletBalance",
                "usdtBalance",
                "USDT",
            )
        ),
        "asset": str(_first(row, "currency", "token", "asset") or "USDT"),
    }


def _wallet_ledger(account: dict[str, Any], name: str) -> dict[str, str]:
    """Read a USDT wallet row from ApeX's account-data response.

    ApeX returns Funding and Contract wallet balances as arrays alongside the
    account metadata; the account objects themselves contain identifiers and
    fee configuration, not balances. Prefer the explicit USDT row and only
    fall back to the sole row when the SDK omits the asset label.
    """
    rows = account.get(name)
    rows = rows if isinstance(rows, list) else []
    candidates = [row for row in rows if isinstance(row, dict)]
    row = next(
        (
            item
            for item in candidates
            if str(_first(item, "token", "asset", "currency") or "").upper() == "USDT"
        ),
        candidates[0] if len(candidates) == 1 else {},
    )
    total = Decimal(_decimal_text(_first(row, "balance", "totalBalance", "walletBalance")))
    explicit_available = _first(row, "availableBalance", "available", "free", "withdrawable")
    if explicit_available is None:
        pending = sum(
            Decimal(_decimal_text(row.get(key)))
            for key in ("pendingWithdrawAmount", "pendingTransferOutAmount")
        )
        available = max(total - pending, Decimal("0"))
    else:
        available = Decimal(_decimal_text(explicit_available))
    return {
        "available": format(available, "f"),
        "total": format(total, "f"),
        "asset": str(_first(row, "token", "asset", "currency") or "USDT"),
    }


def _balance_ledger(value: Any) -> dict[str, str]:
    """Shape ApeX's dedicated /v3/account-balance response for Perps."""
    row = _payload(value)
    return {
        "available": _decimal_text(_first(row, "availableBalance", "available", "free")),
        "total": _decimal_text(
            _first(row, "totalEquityValue", "totalEquity", "equity", "balance")
        ),
        "asset": str(_first(row, "currency", "token", "asset") or "USDT"),
    }


def _sanitized_receipt(value: Any, direction: str) -> dict[str, Any]:
    data = _payload(value)
    return {
        "accepted": bool(data),
        "id": str(_first(data, "id", "transferId", "clientTransferId") or "") or None,
        "status": str(_first(data, "status", "state") or "submitted"),
        "direction": direction,
    }


class ApexCapitalClient:
    def __init__(
        self,
        environment: str,
        creds: RestCreds,
        *,
        zk_seeds: str,
        zk_l2_key: str,
    ) -> None:
        endpoint, network_id, env_id = _env_constants(environment)
        try:
            from apexomni.http_private_sign import HttpPrivateSign
        except Exception as exc:  # pragma: no cover - only without pinned SDK
            raise OrderRestError("SDK_UNAVAILABLE") from exc
        self._client = HttpPrivateSign(
            endpoint,
            network_id=network_id,
            env_id=env_id,
            zk_seeds=str(zk_seeds).removeprefix("0x"),
            zk_l2Key=zk_l2_key,
            api_key_credentials={
                "key": creds.api_key,
                "secret": creds.api_secret,
                "passphrase": creds.passphrase or "",
            },
            request_timeout=8,
            max_retries=1,
        )

    def read_balances(self) -> dict[str, dict[str, str]]:
        self._client.configs_v3()
        account = _payload(self._client.get_account_v3())
        perps = _balance_ledger(self._client.get_account_balance_v3())
        return {
            "funding": _wallet_ledger(account, "spotWallets")
            if isinstance(account.get("spotWallets"), list)
            else _ledger(account, "spotAccount"),
            "perps": perps
            if perps["available"] != "0" or perps["total"] != "0"
            else _wallet_ledger(account, "contractWallets")
            if isinstance(account.get("contractWallets"), list)
            else _ledger(account, "contractAccount"),
        }

    def move_funding_to_perps(self, amount: str, asset: str = "USDT") -> dict[str, Any]:
        self._client.configs_v3()
        self._client.get_account_v3()
        return _sanitized_receipt(
            self._client.create_transfer_out_v3(amount=amount, asset=asset),
            "funding_to_perps",
        )

    def move_perps_to_funding(self, amount: str, asset: str = "USDT") -> dict[str, Any]:
        self._client.configs_v3()
        self._client.get_account_v3()
        return _sanitized_receipt(
            self._client.create_contract_transfer_out_v3(amount=amount, asset=asset),
            "perps_to_funding",
        )
