import os


# The legacy identity header is available only to this isolated test process.
# Production and normal local development require a signed application session.
os.environ["QUORUMARK_LOCAL_IDENTITY_TEST_MODE"] = "true"
