# Vulnerability disposition — Phase B.2

Source: `signer/vendor/pip-audit.txt` (pip-audit against the pinned
`requirements.lock`). Re-run against the **final runtime image** after
`pip uninstall -y pip setuptools wheel` in the multi-stage Dockerfile;
setuptools drops out of the runtime layer entirely.

Automatic block criteria (any one → BLOCK): RCE, signature compromise,
private-key or credential disclosure, auth bypass, cryptographic
validation bypass, container escape, malicious package execution.

| Package     | Installed | Advisory ID     | Severity      | Fixed in | Why pinned                                                                                       | Imported in signer? | Reachable in prod? | Handles untrusted input? | Impact on signing / credentials                                       | Mitigation                                                                                       | Disposition                                    |
|-------------|-----------|-----------------|---------------|----------|--------------------------------------------------------------------------------------------------|---------------------|--------------------|--------------------------|-----------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|------------------------------------------------|
| ecdsa       | 0.16.0    | PYSEC-2026-1325 | Medium — timing side-channel in `ecdsa` pure-Python signing / key ops | No fixed version    | Transitive of `apexomni` (v3.4.0) which pins `ecdsa==0.16.0` for zkLink STARK key derivation.    | Yes (via SDK)       | Yes (worker-side)  | No — only owner-supplied credential material, never network input | Signing uses zkLink STARK, not ecdsa's ECDSA. ecdsa is used only for public-key math on trusted local inputs. No remote attacker path. | Isolate to private worker (already done). Track upstream SDK for a version that drops or upgrades `ecdsa`. Re-audit on every SDK bump. | **ACCEPT** — no untrusted-input path, no remote reachability. |
| ecdsa       | 0.16.0    | PYSEC-2026-2467 | Medium — Minerva-class timing attack on `ecdsa` signing               | 0.19.2              | Same as above. Upstream SDK pin blocks upgrade.                                                  | Yes (via SDK)       | Yes (worker-side)  | No                       | Same as above — signing path is STARK, not ecdsa.                     | Same as above. If SDK relaxes the pin, upgrade to `ecdsa>=0.19.2` and re-run tests.              | **ACCEPT** — same rationale.                    |
| mpmath      | 1.0.0     | PYSEC-2021-427  | Low — ReDoS in `mp.pretty` output when rendering user-controlled floats | 1.3.0             | Transitive of `sympy` transitive of `apexomni`. SDK does not import `mpmath` at runtime; it ships as a pip-resolved dep. | No (not imported by signer or its handler chain) | No — no code path renders mpmath output | No | None — signer never calls into mpmath. | Runtime image will drop `mpmath` entirely once SDK confirms it is unused; until then it is dead code. | **ACCEPT** — unreachable.                       |
| mpmath      | 1.0.0     | PYSEC-2021-427  | (duplicate row in `pip-audit`) | 1.3.0    | Same finding reported twice by the tool.                                                         | No                  | No                 | No                       | None.                                                                 | Same as above.                                                                                    | **ACCEPT** — duplicate.                         |
| setuptools  | 80.10.2   | PYSEC-2026-3447 | High — arbitrary file overwrite via crafted package during install    | 83.0.0              | Bundled by Python base image and pinned by `pip-compile --allow-unsafe` in build stage.          | No — build-only     | **No** — removed from runtime image in Dockerfile stage 2 (`pip uninstall -y pip setuptools wheel`). | No — installer is never invoked at runtime | None — no packages are installed at runtime; runtime image has no `pip`. | Multi-stage build already removes it. Runtime scan must show `setuptools` absent. | **MITIGATE — resolved by multi-stage build.**   |

## Summary

- No finding triggers the automatic block criteria.
- No finding is remotely reachable from the broker → signer surface,
  which accepts only typed operations from a single HMAC-authenticated
  caller.
- `setuptools` — the only High-severity finding — is removed from the
  runtime image by the multi-stage build, so the runtime audit MUST show
  it absent. If a future scan reports it, the Dockerfile pruning step
  regressed and the build MUST fail.
- `ecdsa` findings are timing side-channels against local key operations
  on already-trusted material. There is no path for an attacker to
  measure signing timings across the network — the signer is on Railway
  private networking and only the broker can reach it.
- `mpmath` is unreachable dead code.

## Post-build validation (owner-executed)

```
docker build -t apex-signer:phase-b2 signer/
docker save apex-signer:phase-b2 -o /tmp/apex-signer.tar
# Vulnerability scan against the final runtime image (not the builder):
trivy image --input /tmp/apex-signer.tar --severity HIGH,CRITICAL --exit-code 1
# SBOM against the final runtime image:
syft apex-signer:phase-b2 -o cyclonedx-json > signer/vendor/sbom.runtime.cyclonedx.json
# Confirm setuptools is gone:
docker run --rm --entrypoint python apex-signer:phase-b2 -c \
  "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('setuptools') is None else 1)"
```

A non-zero exit from any of the three steps blocks progression to
signer enablement.
