import { expect, test } from "@playwright/test";

test("core public journeys render", async ({ page }) => {
  for (const path of ["/", "/marketplace", "/studio", "/connect-wallet"]) {
    await page.goto(path);
    await expect(page.locator("body")).toBeVisible();
  }
});

test("wallet selector exposes explicit primary and secondary choices", async ({ page }) => {
  await page.goto("/connect-wallet");
  await expect(page.getByRole("heading", { name: "Connect NEAR Wallet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect EVM Wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect NEAR Wallet/ })).toBeEnabled();
});

test("mobile marketplace remains readable", async ({ page }) => {
  await page.goto("/marketplace");
  await expect(page.locator("body")).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});
