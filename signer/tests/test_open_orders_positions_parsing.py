"""Parsing fixtures for /open-orders and /account (positions).

Regression tests for the false-positive preflight bug: owner's ApeX UI
showed zero exposure, yet preflight reported EXISTING_OPEN_ORDER and
EXISTING_OPEN_POSITION because:
  * get_open_orders returned terminal-state rows (FILLED/CANCELED),
  * get_positions returned size='0' rows for symbols previously traded.
"""
from __future__ import annotations

import pytest

from app import orders_v3
from app.orders_v3 import RestCreds


CREDS = RestCreds(api_key="k", api_secret="s", passphrase="p")


def _install(monkeypatch, method: str, path_expected: str, envelope: dict) -> None:
    def fake_do(m, env, path, params, creds):
        assert m == method
        assert path == path_expected
        return envelope
    monkeypatch.setattr(orders_v3, "_do", fake_do)


# --- get_open_orders --------------------------------------------------

def test_open_orders_empty_envelope_is_empty(monkeypatch):
    _install(monkeypatch, "GET", "/api/v3/open-orders",
             {"code": 0, "data": {"orders": []}})
    assert orders_v3.get_open_orders("mainnet", CREDS, "BTC-USDT") == []


def test_open_orders_empty_list_data_is_empty(monkeypatch):
    _install(monkeypatch, "GET", "/api/v3/open-orders",
             {"code": 0, "data": []})
    assert orders_v3.get_open_orders("mainnet", CREDS, "BTC-USDT") == []


def test_open_orders_filters_terminal_states(monkeypatch):
    _install(monkeypatch, "GET", "/api/v3/open-orders", {"code": 0, "data": [
        {"id": "1", "symbol": "BTC-USDT", "status": "FILLED"},
        {"id": "2", "symbol": "BTC-USDT", "status": "CANCELED"},
        {"id": "3", "symbol": "BTC-USDT", "status": "EXPIRED"},
        {"id": "4", "symbol": "BTC-USDT", "status": "REJECTED"},
    ]})
    assert orders_v3.get_open_orders("mainnet", CREDS, "BTC-USDT") == []


def test_open_orders_keeps_truly_open(monkeypatch):
    _install(monkeypatch, "GET", "/api/v3/open-orders", {"code": 0, "data": [
        {"id": "10", "symbol": "BTC-USDT", "status": "PENDING"},
        {"id": "11", "symbol": "BTC-USDT", "status": "UNTRIGGERED"},
        {"id": "12", "symbol": "BTC-USDT", "status": "PARTIALLY_FILLED"},
        {"id": "13", "symbol": "BTC-USDT", "status": "FILLED"},
    ]})
    ids = [r["id"] for r in orders_v3.get_open_orders("mainnet", CREDS, "BTC-USDT")]
    assert ids == ["10", "11", "12"]


# --- get_positions ----------------------------------------------------

def test_positions_zero_size_row_is_not_open(monkeypatch):
    # Previously-traded BTC-USDT with size='0' must NOT count as open.
    _install(monkeypatch, "GET", "/api/v3/account", {"code": 0, "data": {
        "positions": [
            {"symbol": "BTC-USDT", "size": "0",   "side": "LONG"},
            {"symbol": "ETH-USDT", "size": "0.0", "side": "SHORT"},
        ],
    }})
    assert orders_v3.get_positions("mainnet", CREDS) == []


def test_positions_nonzero_size_is_open(monkeypatch):
    _install(monkeypatch, "GET", "/api/v3/account", {"code": 0, "data": {
        "positions": [
            {"symbol": "BTC-USDT", "size": "0.005", "side": "LONG"},
            {"symbol": "ETH-USDT", "size": "0",     "side": "SHORT"},
        ],
    }})
    out = orders_v3.get_positions("mainnet", CREDS)
    assert len(out) == 1 and out[0]["symbol"] == "BTC-USDT"


def test_positions_closed_status_excluded(monkeypatch):
    _install(monkeypatch, "GET", "/api/v3/account", {"code": 0, "data": {
        "positions": [
            {"symbol": "BTC-USDT", "size": "0.005", "status": "CLOSED"},
        ],
    }})
    assert orders_v3.get_positions("mainnet", CREDS) == []


def test_positions_reads_contract_account_openpositions(monkeypatch):
    _install(monkeypatch, "GET", "/api/v3/account", {"code": 0, "data": {
        "contractAccount": {"openPositions": [
            {"symbol": "BTC-USDT", "size": "0"},         # stale flat row
            {"symbol": "BTC-USDT", "openSize": "0.002"}, # real open
        ]},
    }})
    out = orders_v3.get_positions("mainnet", CREDS)
    assert len(out) == 1 and out[0].get("openSize") == "0.002"
