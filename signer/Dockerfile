# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the ApeX Omni signer.
#
# Both stages pin the same immutable digest resolved from Docker Hub via:
#   docker buildx imagetools inspect python:3.11.9-slim
#
# Resolution record:
#   registry:    docker.io/library
#   tag:         python:3.11.9-slim  (3.11.9-slim-bookworm)
#   digest:      sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317
#   type:        multi-arch OCI image index (linux/amd64, linux/arm64, ...)
#   resolved on: 2026-07-17
# See signer/OWNER_RUNBOOK.md.
#
# --- Stage 1: builder -------------------------------------------------------
FROM python:3.11.9-slim@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317 AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# git is needed only to resolve the pinned apexomni SDK commit. Compiler
# toolchain stays in this stage and never reaches the runtime image.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      git build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install into an isolated prefix so we can copy just the site-packages
# tree into the runtime image.
#
# The lockfile is split exactly as signer-ci.yml does: `pip --require-hashes`
# rejects VCS dependencies (a git URL has no artifact hash), so everything
# except the pinned apexomni commit is installed under hash enforcement, then
# apexomni is installed separately with --no-deps. The commit SHA is the
# integrity pin for that one package. Keep this SHA in sync with
# requirements.in / requirements.lock and the CI workflow.
COPY requirements.lock requirements.in /build/
RUN python -m venv /opt/venv \
 && grep -v 'apexomni @ git+' /build/requirements.lock > /build/requirements-hashed.lock \
 && /opt/venv/bin/pip install --require-hashes -r /build/requirements-hashed.lock \
 && /opt/venv/bin/pip install --no-deps \
      "apexomni @ git+https://github.com/ApeX-Protocol/apexpro-openapi.git@4d849dd84087b9551afaa55d5f37068f7ce0a103"

# --- Stage 2: runtime -------------------------------------------------------
FROM python:3.11.9-slim@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    FASTAPI_DEBUG=0 \
    HOME=/home/signer \
    TMPDIR=/tmp

# Runtime image carries NO compiler, NO git, NO package-manager caches.
# Remove pip/setuptools/wheel from the venv to shrink the runtime attack
# surface (they are only needed at build time). setuptools is a build-only
# dependency and MUST NOT ship in the runtime layer.
COPY --from=builder /opt/venv /opt/venv
RUN /opt/venv/bin/pip uninstall -y pip setuptools wheel || true \
 && find /opt/venv -name '__pycache__' -type d -prune -exec rm -rf '{}' + \
 && rm -rf /root/.cache /var/lib/apt/lists/*

# Non-root user with a fixed uid/gid.
RUN groupadd --system --gid 10001 signer \
 && useradd  --system --uid 10001 --gid signer --home /home/signer --shell /usr/sbin/nologin signer \
 && mkdir -p /home/signer /app \
 && chown -R signer:signer /home/signer /app

WORKDIR /app
COPY --chown=signer:signer app /app/app
COPY --chown=signer:signer shared /app/shared

USER signer:signer

# Read-only root filesystem is enforced by the runtime platform
# (Railway: `readOnlyRootFilesystem: true`). /tmp is provided as a
# writable tmpfs mount by the platform. The application itself writes
# nothing to disk.

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status==200 else 1)"]

# Production server config: no reload, no access log (structured audit is
# a separate stream that excludes bodies/headers), single worker so the
# in-process nonce cache is authoritative. Horizontal scale requires a
# shared nonce store — see OWNER_RUNBOOK.md.
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8080", \
     "--no-access-log", \
     "--workers", "1", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
