from types import ModuleType, SimpleNamespace

from app import apex_capital


class FakePrivate:
    def __init__(self, *args, **kwargs):
        self.calls = []

    def configs_v3(self):
        self.calls.append("configs")
        return {}

    def get_account_v3(self):
        self.calls.append("account")
        return {
            "spotAccount": {"zkAccountId": "1001"},
            "spotWallets": [
                {
                    "token": "USDT",
                    "balance": "14",
                    "pendingWithdrawAmount": "1",
                    "pendingTransferOutAmount": "0.50",
                }
            ],
            "contractAccount": {"takerFeeRate": "0.0005"},
            "contractWallets": [{"token": "USDT", "balance": "9.25"}],
        }

    def get_account_balance_v3(self):
        self.calls.append("account_balance")
        return {"data": {"availableBalance": "7", "totalEquityValue": "9.25"}}

    def create_transfer_out_v3(self, **kwargs):
        self.calls.append(("to_perps", kwargs))
        return {"data": {"id": "a1", "status": "PENDING"}}

    def create_contract_transfer_out_v3(self, **kwargs):
        self.calls.append(("to_funding", kwargs))
        return {"data": {"id": "b1", "status": "PENDING"}}


def client(monkeypatch):
    monkeypatch.setattr(apex_capital, "_env_constants", lambda _env: ("https://example", 1, 1))
    import sys
    package = ModuleType("apexomni")
    package.__path__ = []
    module = ModuleType("apexomni.http_private_sign")
    module.HttpPrivateSign = FakePrivate
    monkeypatch.setitem(sys.modules, "apexomni", package)
    monkeypatch.setitem(sys.modules, "apexomni.http_private_sign", module)
    creds = SimpleNamespace(api_key="k", api_secret="s", passphrase="p")
    return apex_capital.ApexCapitalClient("testnet", creds, zk_seeds="0x01", zk_l2_key="02")


def test_reads_funding_and_perps_without_raw_account(monkeypatch):
    c = client(monkeypatch)
    assert c.read_balances() == {
        "funding": {"available": "12.50", "total": "14", "asset": "USDT"},
        "perps": {"available": "7", "total": "9.25", "asset": "USDT"},
    }


def test_moves_only_between_internal_ledgers(monkeypatch):
    c = client(monkeypatch)
    assert c.move_funding_to_perps("5") == {
        "accepted": True, "id": "a1", "status": "PENDING", "direction": "funding_to_perps"
    }
    assert c.move_perps_to_funding("3") == {
        "accepted": True, "id": "b1", "status": "PENDING", "direction": "perps_to_funding"
    }
