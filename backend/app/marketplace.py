from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .contracts import evidence_hash
from .repository import PaperRepository
from .security import require_verified_identity


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


require_local_identity = require_verified_identity


class StrategyDraftRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    thesis: str = Field(min_length=10, max_length=2_000)
    market: str = Field(min_length=2, max_length=80)
    supported_assets: list[str] = Field(min_length=1, max_length=20)
    risk_class: str = Field(pattern="^(low|medium|high)$")
    cadence: str = Field(default="Every 4 hours", min_length=2, max_length=80)
    monthly_price: float = Field(default=0, ge=0, le=100_000)
    definition: dict[str, Any] = Field(default_factory=dict)


class StrategyVersionRequest(BaseModel):
    version: str = Field(min_length=1, max_length=40, pattern=r"^v[0-9]+(?:\.[0-9]+)*$")
    definition: dict[str, Any] = Field(default_factory=dict)
    backtest_id: str | None = Field(default=None, max_length=100)
    backtest_metrics: dict[str, Any] | None = None
    evidence_hash: str | None = Field(default=None, max_length=128)


class SubscriptionRequest(BaseModel):
    strategy_id: str = Field(min_length=1, max_length=120)
    environment: str = Field(default="sandbox", pattern="^(sandbox|near_testnet)$")


class PolicyRequest(BaseModel):
    capital: float = Field(gt=0, le=10_000_000)
    max_trade: float = Field(gt=0)
    max_position: float = Field(gt=0)
    max_loss: float = Field(gt=0)
    max_slippage_bps: int = Field(default=30, ge=0, le=500)
    approved_assets: list[str] = Field(min_length=1)
    paused: bool = False


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:70] or "strategy"


def create_strategy(repository: PaperRepository, creator_id: str, request: StrategyDraftRequest) -> dict[str, Any]:
    strategy_id = str(uuid.uuid4())
    slug = f"{slugify(request.name)}-{strategy_id[-6:]}"
    strategy = {
        "id": strategy_id,
        "slug": slug,
        "creator_id": creator_id,
        "name": request.name.strip(),
        "thesis": request.thesis.strip(),
        "market": request.market.strip(),
        "supported_assets": [asset.strip().upper() for asset in request.supported_assets],
        "risk_class": request.risk_class,
        "cadence": request.cadence.strip(),
        "monthly_price": request.monthly_price,
        "status": "draft",
        "current_version": "v1.0",
        "evidence_class": "backtested",
        "created_at": utc_now(),
        "published_at": None,
    }
    repository.save_strategy(strategy)
    repository.save_strategy_version(
        strategy_id,
        "v1.0",
        request.definition,
        None,
        None,
        evidence_hash(request.definition),
        utc_now(),
    )
    return strategy


def to_public_strategy(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    row.pop("creator_id", None)
    return row
