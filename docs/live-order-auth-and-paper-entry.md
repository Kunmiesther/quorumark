# Live-order authentication and paper entry — 2026-09-25

## Evidence

- Production worker heartbeat was healthy; both ApeX and Aster reconciliations were current.
- The last observed ApeX automated entry at 03:45 UTC was rejected with HTTP 401 at the Railway broker. Several earlier confirmed entries had the same result.
- Python signs the exact serialized JSON request, retaining floats such as `2.0`. The broker previously parsed and reserialized with JavaScript, changing that value to `2`. The standard TP ladder contains `2.0`; the different bytes produce different HMACs.
- A broker regression reproduces that failure and verifies the versioned raw-body fix. Replay, timestamp, credential and tamper checks remain enforced. Legacy canonical-v1 clients retain their contract.
- Worker diagnostics previously discarded broker `{error: CODE}` responses. Bounded uppercase machine codes now survive as rejection reasons; arbitrary response text does not.
- Separately, current strategy rows select only Accumulator. Recent observations route to other Turtle evaluators and report `turtle_not_enabled`. This patch does not change that selection, risk parameters, positions or live authorization.

## Paper testing

The welcome page provides “Try paper trading with Google.” A time-limited, same-tab navigation intent survives OAuth and onboarding, then opens `/trade?book=paper`. Returning users reach paper directly; new users retain the existing onboarding flow, where exchange and wallet connection can be skipped. Ordinary sign-in still opens Home. No new callback allowlist entry is required; the existing `/auth/callback` is unchanged.

This navigation choice does not disarm an existing live plan or change account-wide trading configuration. Browser storage failure is reported before starting the paper OAuth flow. Actual Google account authorization still requires the user.

## Verification boundary

Mocked HTTP-boundary tests exercise authentication, tampering, replay rejection and signer forwarding without contacting an exchange. Passing these tests is not evidence of a new live fill. After deployment, inspect subsequent execution results before claiming live execution success. Do not send a real order merely to test authentication.

SynFutures remains at the documented read/quote stage; this patch does not add on-chain execution.
