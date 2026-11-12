from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)


class AIUnavailableError(RuntimeError):
    """Raised when an AI provider is not configured or cannot be reached."""


class AIProviderError(RuntimeError):
    """Raised when a configured provider returns an unusable response."""


class IndicatorProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    parameters: dict[str, float | int | str] = Field(default_factory=dict)
    purpose: str = Field(min_length=1, max_length=500)


class StrategyProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=2, max_length=120)
    description: str = Field(min_length=10, max_length=2_000)
    thesis: str = Field(min_length=10, max_length=2_000)
    instruments: list[str] = Field(min_length=1, max_length=20)
    timeframe: str = Field(min_length=1, max_length=40)
    indicators: list[IndicatorProposal] = Field(max_length=12)
    entry_conditions: list[str] = Field(min_length=1, max_length=20)
    exit_conditions: list[str] = Field(min_length=1, max_length=20)
    stop_loss: str = Field(min_length=1, max_length=500)
    take_profit: str = Field(min_length=1, max_length=500)
    position_sizing: str = Field(min_length=1, max_length=500)
    risk_constraints: list[str] = Field(min_length=1, max_length=20)
    unsupported_assumptions: list[str] = Field(max_length=20)
    rationale: str = Field(min_length=10, max_length=2_000)
    simple_explanation: str = Field(default="", max_length=2_000)


class AIAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observed_facts: list[str] = Field(min_length=1, max_length=20)
    calculated_metrics: list[str] = Field(max_length=20)
    risks: list[str] = Field(min_length=1, max_length=20)
    suggestions: list[str] = Field(max_length=20)
    action: Literal["accept", "reject", "no_action"]
    rationale: str = Field(min_length=10, max_length=2_000)


class AgentAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observed_facts: list[str] = Field(min_length=1, max_length=20)
    risks: list[str] = Field(min_length=1, max_length=20)
    action: Literal["accept", "reject", "no_action"]
    signal_reason: str = Field(min_length=10, max_length=1_000)
    rationale: str = Field(min_length=10, max_length=2_000)


PROPOSAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "name", "description", "thesis", "instruments", "timeframe", "indicators",
        "entry_conditions", "exit_conditions", "stop_loss", "take_profit",
        "position_sizing", "risk_constraints", "unsupported_assumptions", "rationale", "simple_explanation",
    ],
    "properties": {
        "name": {"type": "string", "minLength": 2, "maxLength": 120},
        "description": {"type": "string", "minLength": 10, "maxLength": 2000},
        "thesis": {"type": "string", "minLength": 10, "maxLength": 2000},
        "instruments": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "timeframe": {"type": "string", "minLength": 1, "maxLength": 40},
        "indicators": {"type": "array", "maxItems": 12, "items": {"type": "object", "additionalProperties": False, "required": ["name", "parameters", "purpose"], "properties": {"name": {"type": "string"}, "parameters": {"type": "object", "additionalProperties": {"type": ["number", "integer", "string"]}}, "purpose": {"type": "string"}}}},
        "entry_conditions": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "exit_conditions": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "stop_loss": {"type": "string"},
        "take_profit": {"type": "string"},
        "position_sizing": {"type": "string"},
        "risk_constraints": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "unsupported_assumptions": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        "rationale": {"type": "string", "minLength": 10, "maxLength": 2000},
        "simple_explanation": {"type": "string", "minLength": 10, "maxLength": 2000},
    },
}

ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["observed_facts", "calculated_metrics", "risks", "suggestions", "action", "rationale"],
    "properties": {
        "observed_facts": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "calculated_metrics": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        "risks": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "suggestions": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        "action": {"type": "string", "enum": ["accept", "reject", "no_action"]},
        "rationale": {"type": "string", "minLength": 10, "maxLength": 2000},
    },
}

AGENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["observed_facts", "risks", "action", "signal_reason", "rationale"],
    "properties": {
        "observed_facts": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "risks": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
        "action": {"type": "string", "enum": ["accept", "reject", "no_action"]},
        "signal_reason": {"type": "string", "minLength": 10, "maxLength": 1000},
        "rationale": {"type": "string", "minLength": 10, "maxLength": 2000},
    },
}


class _RateGate:
    def __init__(self) -> None:
        self._events: deque[float] = deque()
        self._lock = threading.Lock()

    def check(self, limit: int) -> None:
        now = time.monotonic()
        with self._lock:
            while self._events and now - self._events[0] >= 60:
                self._events.popleft()
            if len(self._events) >= limit:
                raise AIUnavailableError("AI request rate limit reached; try again shortly")
            self._events.append(now)


_rate_gate = _RateGate()


def _config() -> tuple[str, str, str, int, float, int, int]:
    provider = os.getenv("AI_PROVIDER", "disabled").strip().lower()
    api_key = os.getenv("NEAR_AI_API_KEY", "").strip() if provider == "near_ai" else os.getenv("AI_API_KEY", "").strip()
    api_url_name = "NEAR_AI_API_URL" if provider == "near_ai" else "AI_API_URL"
    api_url = os.getenv(api_url_name, "").strip()
    if not api_url:
        api_url = "https://cloud-api.near.ai/v1" if provider == "near_ai" else "https://api.openai.com/v1/responses"
    model_name = "NEAR_AI_MODEL" if provider == "near_ai" else "AI_MODEL"
    model = os.getenv(model_name, "").strip() or os.getenv("AI_MODEL", "").strip()
    try:
        limit = int(os.getenv("AI_RATE_LIMIT_PER_MINUTE", "").strip() or "10")
        timeout = float(os.getenv("AI_REQUEST_TIMEOUT_SECONDS", "").strip() or "30")
        max_output_tokens = int(os.getenv("AI_MAX_OUTPUT_TOKENS", "").strip() or "1200")
        max_retries = int(os.getenv("AI_MAX_RETRIES", "").strip() or "2")
    except ValueError as error:
        raise AIUnavailableError("AI strategy assistance has invalid server configuration") from error
    if provider in {"", "disabled"}:
        raise AIUnavailableError("AI strategy assistance is unavailable: AI_PROVIDER is disabled")
    if provider not in {"openai", "openai_compatible", "near_ai", "gemini"}:
        raise AIUnavailableError(f"AI strategy assistance is unavailable: unsupported provider '{provider}'")
    if not api_key or not model:
        raise AIUnavailableError("AI strategy assistance is unavailable: provider credentials or AI_MODEL are missing")
    return api_key, api_url, model, max(limit, 1), max(timeout, 1.0), max(max_output_tokens, 1), max(max_retries, 0)


def _output_text(payload: dict[str, Any]) -> str:
    direct = payload.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct
    chunks: list[str] = []
    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and isinstance(content.get("text"), str):
                chunks.append(content["text"])
    if chunks:
        return "".join(chunks)
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {})
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and content.strip():
            return content
    raise AIProviderError("AI provider returned no structured output")


def _gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Reduce our JSON Schema to Gemini's documented structured-output subset."""
    allowed = {"type", "description", "enum", "properties", "required", "items"}
    result = {key: value for key, value in schema.items() if key in allowed}
    if isinstance(schema.get("properties"), dict):
        result["properties"] = {key: _gemini_schema(value) for key, value in schema["properties"].items()}
    if isinstance(schema.get("items"), dict):
        result["items"] = _gemini_schema(schema["items"])
    if isinstance(schema.get("type"), list):
        result["type"] = schema["type"]
    return result


def _gemini_output_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise AIProviderError("Gemini returned no candidate output")
    parts = candidates[0].get("content", {}).get("parts", [])
    chunks = [part["text"] for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)]
    if not chunks:
        raise AIProviderError("Gemini returned no structured output")
    return "".join(chunks)


def _request(schema_name: str, schema: dict[str, Any], instruction: str) -> tuple[dict[str, Any], dict[str, str]]:
    api_key, api_url, model, limit, timeout, max_output_tokens, max_retries = _config()
    _rate_gate.check(limit)
    provider = os.getenv("AI_PROVIDER", "").strip().lower()
    if provider == "gemini":
        body = {
            "systemInstruction": {"parts": [{"text": "You are a careful financial research assistant. Return only the requested JSON object. Never emit executable code. Separate observed facts, calculated metrics, and suggestions."}]},
            "contents": [{"role": "user", "parts": [{"text": instruction}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": _gemini_schema(schema), "temperature": 0.2, "maxOutputTokens": max_output_tokens},
        }
        url = api_url.rstrip("/") + f"/v1beta/models/{model}:generateContent" if "/models/" not in api_url else api_url
        headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    elif provider == "near_ai":
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a careful financial research assistant. Return only the requested JSON object. Never emit executable code. Separate observed facts, calculated metrics, and suggestions."},
                {"role": "user", "content": instruction},
            ],
            "temperature": 0.2,
            "max_tokens": max_output_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "strict": True, "schema": schema},
            },
        }
        url = api_url.rstrip("/") + "/chat/completions" if "/chat/completions" not in api_url else api_url
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    else:
        body = {
            "model": model,
            "input": [{"role": "system", "content": "You are a careful financial research assistant. Return only the requested JSON object. Never emit executable code. Separate observed facts, calculated metrics, and suggestions."}, {"role": "user", "content": instruction}],
            "text": {"format": {"type": "json_schema", "name": schema_name, "strict": True, "schema": schema}},
            "max_output_tokens": max_output_tokens,
        }
        url = api_url
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    response = None
    for attempt in range(max_retries + 1):
        try:
            response = httpx.post(url, headers=headers, json=body, timeout=timeout)
        except httpx.HTTPError as error:
            logger.warning("AI provider network failure provider=%s model=%s error_type=%s", provider, model, type(error).__name__)
            if attempt == max_retries:
                raise AIUnavailableError("AI provider could not be reached. Try again shortly.") from error
            time.sleep(0.5 * (attempt + 1))
            continue
        if response.status_code < 500 or attempt == max_retries:
            break
        time.sleep(0.5 * (attempt + 1))
    assert response is not None
    if response.status_code in {401, 403}:
        logger.warning("AI provider credentials rejected provider=%s model=%s status=%s", provider, model, response.status_code)
        raise AIUnavailableError("The AI assistant is not authorized. Check the server-side provider key.")
    if response.status_code == 429:
        logger.warning("AI provider rate limited provider=%s model=%s", provider, model)
        raise AIUnavailableError("The AI assistant is busy right now. Please wait a moment and try again.")
    if response.status_code in {400, 404}:
        try:
            error_payload = response.json().get("error", {})
            provider_status = str(error_payload.get("status", "")).upper()
            provider_message = str(error_payload.get("message", "")).lower()
        except (ValueError, TypeError, AttributeError):
            provider_status, provider_message = "", ""
        if response.status_code == 404 or provider_status == "NOT_FOUND" or "model" in provider_message:
            logger.warning("AI provider model unavailable provider=%s model=%s status=%s provider_status=%s", provider, model, response.status_code, provider_status or "unknown")
            raise AIUnavailableError("The configured AI model is unavailable. Choose a supported free model in the server configuration.")
        logger.warning("AI provider rejected request provider=%s model=%s status=%s provider_status=%s", provider, model, response.status_code, provider_status or "unknown")
        raise AIProviderError("The AI assistant rejected this request. Try again or simplify the strategy idea.")
    if response.status_code >= 500:
        logger.warning("AI provider service failure provider=%s model=%s status=%s", provider, model, response.status_code)
        raise AIUnavailableError("The AI assistant is temporarily unavailable. Please try again shortly.")
    if not response.is_success:
        logger.warning("AI provider unexpected response provider=%s model=%s status=%s", provider, model, response.status_code)
        raise AIProviderError("The AI assistant returned an unexpected response. Please try again.")
    try:
        payload = response.json()
        text = _gemini_output_text(payload) if provider == "gemini" else _output_text(payload)
        raw = json.loads(text)
        return raw, {"provider": provider, "model": model}
    except (json.JSONDecodeError, ValidationError, TypeError, ValueError) as error:
        raise AIProviderError("AI provider returned invalid JSON") from error


def generate_strategy_proposal(prompt: str, current_proposal: StrategyProposal | None = None) -> tuple[StrategyProposal, dict[str, str]]:
    if not prompt.strip() or len(prompt.strip()) > 4_000:
        raise ValueError("Strategy request must contain between 1 and 4,000 characters")
    context = f"\nCurrent proposal to refine:\n{current_proposal.model_dump_json()}" if current_proposal else ""
    instruction = f"Create or refine a strategy proposal from this creator request. Keep assumptions explicit and do not generate executable code. Write simple_explanation in short everyday language for a beginner: say what the strategy watches, when it might make a practice trade, when it waits, how it tries to limit losses, and what could go wrong. Do not use indicator acronyms or exact numeric thresholds in simple_explanation; keep those in the advanced rule fields. Creator request: {prompt.strip()}{context}"
    raw, metadata = _request("strategy_proposal", PROPOSAL_SCHEMA, instruction)
    try:
        return StrategyProposal.model_validate(raw), metadata
    except ValidationError as error:
        raise AIProviderError("AI provider output failed strategy schema validation") from error


def analyze_strategy(strategy: dict[str, Any], metrics: dict[str, Any], question: str) -> tuple[AIAnalysis, dict[str, str]]:
    if len(question.strip()) > 2_000:
        raise ValueError("Analysis question must be at most 2,000 characters")
    instruction = json.dumps({"question": question.strip() or "Explain the main risks and observations.", "strategy": strategy, "calculated_metrics": metrics}, sort_keys=True)
    raw, metadata = _request("strategy_analysis", ANALYSIS_SCHEMA, f"Analyze this approved strategy using only the supplied calculated metrics and strategy context. Do not invent market observations. Write the rationale in short everyday language for a beginner. Say what the strategy watches, when it might act, when it waits, how it tries to limit losses, and what could go wrong. Do not mention indicator acronyms or exact thresholds in the rationale; keep technical detail in calculated_metrics and suggestions. Input: {instruction}")
    try:
        return AIAnalysis.model_validate(raw), metadata
    except ValidationError as error:
        raise AIProviderError("AI provider output failed analysis schema validation") from error


def evaluate_agent(strategy: dict[str, Any], metrics: dict[str, Any], market_observations: dict[str, Any]) -> tuple[AgentAssessment, dict[str, str]]:
    instruction = json.dumps({"strategy": strategy, "calculated_metrics": metrics, "market_observations": market_observations}, sort_keys=True)
    raw, metadata = _request("agent_assessment", AGENT_SCHEMA, f"Evaluate this version-bound strategy against the supplied market observations. Do not invent observations or place orders. Return accept only when the supplied observations support a paper signal; return reject or no_action otherwise. Input: {instruction}")
    try:
        return AgentAssessment.model_validate(raw), metadata
    except ValidationError as error:
        raise AIProviderError("AI provider output failed agent-assessment schema validation") from error
