import unittest
from unittest.mock import Mock

from app import synfutures_reconciliation as r


def row():
    return dict(intent_id="intent", user_id="owner", connection_id="connection", chain_id=8453,
        operator_address="0x" + "11" * 20, module_address="0x" + "22" * 20, safe_address="0x" + "33" * 20,
        instrument_address="0x04d72fb4803b4e02f14971e5bd092375eb330749", operator_nonce="6",
        module_revision="3", module_nonce="9007199254740993", signed_size="-100000000000000000",
        margin="0", reduce_only=True, tx_hash="0x" + "ab" * 32)


def fixture(record):
    block = "0x" + "cd" * 32
    words = [int(record["signed_size"]) % 2**256, int(record["margin"]), int(record["reduce_only"])]
    event = dict(address=record["module_address"], removed=False, transactionHash=record["tx_hash"],
        blockHash=block, blockNumber="0x100", topics=[r.TRADE_EVENT] + ["0x" + format(n, "064x") for n in
            [int(record["module_revision"]), int(record["module_nonce"]), int(record["instrument_address"], 16)]],
        data="0x" + "".join(format(n, "064x") for n in words))
    receipt = dict(transactionHash=record["tx_hash"], blockHash=block, blockNumber="0x100", status="0x1",
                   logs=[event], to=record["module_address"], **{"from": record["operator_address"]})
    trade_words = [int(record["module_revision"]), int(record["module_nonce"]), int(record["instrument_address"], 16),
                   int(record["signed_size"]) % 2**256, int(record["margin"]), (-100) % 2**256, 2_000_000_000, int(record["reduce_only"])]
    transaction = dict(hash=record["tx_hash"], blockHash=block, blockNumber="0x100", chainId="0x2105", nonce="0x6", value="0x0",
                       input="0x" + r.EXECUTE_TRADE_SELECTOR + "".join(format(n, "064x") for n in trade_words),
                       to=record["module_address"], **{"from": record["operator_address"]})
    responses = {"eth_chainId": "0x2105", "eth_getTransactionReceipt": receipt,
        "eth_getTransactionByHash": transaction}
    finalized = dict(number="0x110", hash="0x" + "ef" * 32)
    canonical = dict(number="0x100", hash=block)
    def call(method, params):
        if method == "eth_getBlockByNumber":
            return finalized if params[0] == "finalized" else canonical
        return responses[method]
    return Mock(side_effect=call), responses, finalized, canonical


class SynFuturesReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.record = row()
        self.rpc, self.responses, self.finalized, self.canonical = fixture(self.record)
        self.db = Mock()
        self.db.list_synfutures_transactions.return_value = [self.record]

    def reconcile(self):
        return r.reconcile_connection(db=self.db, rpc=self.rpc, user_id="owner", connection_id="connection")

    def test_exact_finalized_trade_recovers_without_resubmission(self):
        self.assertEqual(self.reconcile(), dict(status="reconciled", reconciliation_required=False, observed=1, unknown=0))
        self.assertEqual(self.db.observe_synfutures_transaction.call_args.kwargs["state"], "confirmed")
        self.assertTrue(all(call.args[0] in r.BaseReadRpc.METHODS for call in self.rpc.call_args_list))

    def test_reverted_receipt_is_failed_not_filled(self):
        self.responses["eth_getTransactionReceipt"]["status"] = "0x0"
        self.responses["eth_getTransactionReceipt"]["logs"] = []
        self.reconcile()
        self.assertEqual(self.db.observe_synfutures_transaction.call_args.kwargs["state"], "reverted")

    def test_missing_receipt_after_restart_is_unknown(self):
        self.responses["eth_getTransactionReceipt"] = None
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_unfinalized_receipt_is_not_a_fill(self):
        self.finalized["number"] = "0xff"
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_reorg_is_unknown(self):
        self.canonical["hash"] = "0x" + "98" * 32
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_wrong_network_is_unknown(self):
        self.responses["eth_chainId"] = "0x1"
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_missing_event_does_not_mean_success(self):
        self.responses["eth_getTransactionReceipt"]["logs"] = []
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_wrong_event_or_transaction_identity_never_fills(self):
        for key, value in [("address", "0x"+"44"*20), ("removed", True), ("removed", None),
                           ("transactionHash", "0x"+"55"*32), ("data", "0x"+"00"*96)]:
            with self.subTest(key=key, value=value):
                self.rpc, self.responses, _, _ = fixture(self.record)
                self.responses["eth_getTransactionReceipt"]["logs"][0][key] = value
                self.assertTrue(self.reconcile()["reconciliation_required"])
        for key, value in [("nonce", "0x7"), ("value", "0x1"), ("to", "0x"+"44"*20),
                           ("from", "0x"+"44"*20), ("blockHash", "0x"+"44"*32),
                           ("chainId", "0x1"), ("chainId", None), ("blockNumber", "0x101")]:
            with self.subTest(transaction_key=key):
                self.rpc, self.responses, _, _ = fixture(self.record)
                self.responses["eth_getTransactionByHash"][key] = value
                self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_trade_selector_matches_contract_signature(self):
        from eth_utils import keccak
        self.assertEqual(keccak(text="executeTrade((uint256,uint256,address,int128,uint128,int24,uint32,bool))")[:4].hex(),
                         r.EXECUTE_TRADE_SELECTOR)

    def test_success_event_cannot_override_different_calldata(self):
        for word, value in [(0, 4), (1, 0), (2, int("44"*20, 16)), (3, 1), (4, 1),
                            (5, 2**23), (5, 2**24-100), (6, 0), (6, 2**32), (7, 0), (7, 2)]:
            with self.subTest(word=word, value=value):
                self.rpc, self.responses, _, _ = fixture(self.record)
                tx = self.responses["eth_getTransactionByHash"]
                start = 10 + word * 64
                tx["input"] = tx["input"][:start] + format(value, "064x") + tx["input"][start+64:]
                self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_missing_extra_or_wrong_function_data_stays_unknown(self):
        original = self.responses["eth_getTransactionByHash"]["input"]
        for value in [None, "0x", original[:-2], original + "00", "0x00000000" + original[10:]]:
            with self.subTest(input=value):
                self.responses["eth_getTransactionByHash"]["input"] = value
                self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_reverted_unrelated_call_cannot_release_trade_reservation(self):
        self.responses["eth_getTransactionReceipt"].update(status="0x0", logs=[])
        self.responses["eth_getTransactionByHash"]["input"] = "0x"
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_canonical_tick_boundaries_and_max_deadline(self):
        for tick in [-(2**23), -1, 0, 2**23-1]:
            with self.subTest(tick=tick):
                self.rpc, self.responses, _, _ = fixture(self.record)
                tx = self.responses["eth_getTransactionByHash"]
                start = 10 + 5 * 64
                tx["input"] = tx["input"][:start] + format(tick % 2**256, "064x") + format(2**32-1, "064x") + tx["input"][start+128:]
                self.assertFalse(self.reconcile()["reconciliation_required"])

    def test_duplicate_events_are_not_accepted(self):
        logs = self.responses["eth_getTransactionReceipt"]["logs"]
        logs.append(logs[0].copy())
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_integer_precision_must_be_preserved(self):
        self.record["module_nonce"] = 9007199254740993
        self.assertTrue(self.reconcile()["reconciliation_required"])
        self.rpc.assert_not_called()

    def test_missing_finality_support_is_unknown(self):
        self.rpc.side_effect = r.SynFuturesObservationError("SYNFUTURES_RPC_UNAVAILABLE")
        self.assertTrue(self.reconcile()["reconciliation_required"])

    def test_durable_write_failure_is_not_success(self):
        self.db.observe_synfutures_transaction.side_effect = RuntimeError("db unavailable")
        with self.assertRaises(RuntimeError): self.reconcile()

    def test_foreign_connection_never_observed(self):
        self.record["connection_id"] = "foreign"
        with self.assertRaises(r.SynFuturesObservationError): self.reconcile()
        self.rpc.assert_not_called()
        self.db.observe_synfutures_transaction.assert_not_called()

    def test_buy_entry_event_also_supported(self):
        self.record.update(signed_size="100000000000000000", margin="10000000000000000000", reduce_only=False)
        self.rpc, self.responses, _, _ = fixture(self.record)
        self.assertFalse(self.reconcile()["reconciliation_required"])

    def test_rpc_endpoint_not_supplied_by_caller(self):
        for value in ["http://rpc", "https://user:secret@rpc", "file:///key", "https://rpc/#secret"]:
            with self.assertRaises(r.SynFuturesObservationError): r.BaseReadRpc(value)


if __name__ == "__main__":
    unittest.main()


class SynFuturesProvisionalTests(unittest.TestCase):
    def test_only_exact_mined_success_grants_reduction_proof(self):
        record=row();rpc,responses,finalized,canonical=fixture(record);finalized['number']='0xff'
        self.assertEqual(r.observe_transaction(record,rpc,include_provisional=True)['state'],'mined')
        self.assertEqual(r.observe_transaction(record,rpc)['state'],'unknown')
        responses['eth_getTransactionReceipt']['status']='0x0'
        self.assertEqual(r.observe_transaction(record,rpc,include_provisional=True)['state'],'unknown')
    def test_reorg_and_missing_or_unbound_event_never_grant_protection(self):
        for mutation in ('reorg','missing','foreign','input'):
            with self.subTest(mutation=mutation):
                record=row();rpc,responses,finalized,canonical=fixture(record);finalized['number']='0xff'
                if mutation=='reorg':canonical['hash']='0x'+'ff'*32
                elif mutation=='missing':responses['eth_getTransactionReceipt']['logs']=[]
                elif mutation=='foreign':responses['eth_getTransactionReceipt']['logs'][0]['transactionHash']='0x'+'ff'*32
                else:responses['eth_getTransactionByHash']['input']='0x'
                with self.assertRaises(r.SynFuturesObservationError):r.observe_transaction(record,rpc,include_provisional=True)
