# Signer topology — Phase B.2

## Actually used

```
Browser  ─▶  Supabase Edge Function `execution-broker`
                │  (server-side, service-role auth,
                │   typed operation allowlist)
                ▼
           Railway service `apex-signer`
                │  (HMAC + timestamp + nonce over
                │   method|path|body, single caller)
                ▼
           ApeX Omni REST (mainnet)
```

- Browser never contacts the signer directly.
- Only `execution-broker` holds `SIGNER_SHARED_SECRET`.
- The signer's `/v1/*` routes require HMAC on every call; `/healthz`
  returns `{"ok":true}` and nothing else.
- All four `APEX_MAINNET_*` flags live on the Railway signer only. The
  broker cannot flip them.

## Private-network constraint

Railway private networking (`*.railway.internal`) is reachable **only
from other services inside the same Railway project**. Supabase Edge
Functions run outside Railway and cannot resolve `*.railway.internal`.

Options in order of preference:

1. **Preferred:** move the broker onto Railway alongside the signer, so
   the broker calls `http://apex-signer.railway.internal:8080`
   directly. The Supabase edge function stays as the browser-facing
   entry point but only forwards to the Railway broker over a
   service-role-authenticated HTTPS call. This keeps the signer off the
   public internet entirely.

2. **Deviation (documented, only if 1 is not possible right now):**
   expose the Railway signer over TLS on a narrowly public hostname
   with **all** of these enforced in the signer itself:
   - HMAC + timestamp + nonce on every request (already implemented).
   - Default-deny typed operation allowlist (already implemented in
     `app/operations.py`).
   - Per-IP rate limit at the Railway edge (owner-configured).
   - Cloudflare / Railway allowlist of the Supabase Edge Function
     egress IP range only.
   - No `/docs`, no `/openapi.json`, no `/redoc` (already disabled in
     `app.main`).
   - Structured logs never contain bodies or headers (already enforced
     via `enforce_signed_request` + `sanitize_response`).

   This deviation is acceptable **only** because the signer is
   default-deny — every real operation stays behind
   `APEX_MAINNET_SIGNER_ENABLED=false` until the owner explicitly flips
   it.

**Do not** expose an unauthenticated public workaround. The signer must
never accept a request without HMAC, even for health checks that touch
credential state.

## Reachability tests the owner must run

From inside the Railway network (or the Supabase egress if option 2 is
used):

```
# Should return 200 {"ok":true}
curl -sS https://<signer-host>/healthz

# Should return 401 MISSING_AUTH_HEADERS
curl -sS -X POST https://<signer-host>/v1/onboard -d '{}'

# Should return 401 REPLAYED_NONCE on second call with same nonce.
# Should return 401 TIMESTAMP_SKEW with ts ±999s.
# Should return 401 INVALID_HMAC_SIGNATURE with a tampered body.
# Should return 403 SIGNER_DISABLED for a valid /v1/sign-order call
# while APEX_MAINNET_SIGNER_ENABLED=false.
```

From the public internet with option 1 (private-only): every call must
fail to connect. With option 2: `/healthz` returns 200 and every `/v1/*`
call returns 401 without valid HMAC.
