from __future__ import annotations

import hashlib
import json
from typing import Any


PUBLICATION_SCHEMA_VERSION = "quorumark.publication.v1"
PUBLICATION_DOMAIN = "quorumark:near:testnet:publication:v1"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def publication_commitment(record: dict[str, Any]) -> str:
    payload = {"domain": PUBLICATION_DOMAIN, "schema_version": PUBLICATION_SCHEMA_VERSION, "record": record}
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
