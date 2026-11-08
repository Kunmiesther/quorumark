from app.publication_evidence import publication_commitment


def test_publication_commitment_is_deterministic_and_key_order_independent():
    left = publication_commitment({"strategy_id": "s", "version_id": "v", "network": "near:testnet"})
    right = publication_commitment({"network": "near:testnet", "version_id": "v", "strategy_id": "s"})
    assert left == right
    assert len(left) == 64


def test_publication_commitment_is_domain_separated():
    assert publication_commitment({"strategy_id": "s"}) != "s"
