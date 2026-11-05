"""Credential-free browser smoke test; never connects to a real backend/venue.

Run against a local dev server with placeholder Supabase configuration:
  python scripts/browser-auth-smoke.py
This checks rendering and signed-out guards, not live order execution.
"""
import json
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        page.route(
            "**/*",
            lambda route: route.continue_()
            if urlparse(route.request.url).hostname in ("127.0.0.1", "localhost")
            else route.abort(),
        )
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        results = []
        for path in ("/welcome", "/trade?book=live", "/trade?book=paper", "/exchanges"):
            page.goto("http://127.0.0.1:5187" + path, wait_until="networkidle", timeout=60000)
            expect(page).to_have_url("http://127.0.0.1:5187/welcome")
            # Accessible name includes the explanatory second line in the button.
            expect(page.get_by_role("button", name="Try paper trading with Google")).to_be_visible()
            expect(page.get_by_role("button", name="Google", exact=True)).to_be_visible()
            results.append({"requested": path, "landed": page.url})
        assert not errors, f"Browser runtime errors: {errors}"
        print(json.dumps({"passed": results, "page_errors": errors}, indent=2))
    finally:
        browser.close()
