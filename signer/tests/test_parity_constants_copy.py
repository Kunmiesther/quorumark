"""The signer image must ship the same ratified constants as the worker/UI."""
import json
from pathlib import Path


def test_signer_packaged_parity_constants_match_repository_source():
    repo = Path(__file__).resolve().parents[2]
    source = json.loads((repo / "shared/mainnet_parity_constants.json").read_text())
    packaged = json.loads((repo / "signer/shared/mainnet_parity_constants.json").read_text())
    assert packaged == source
