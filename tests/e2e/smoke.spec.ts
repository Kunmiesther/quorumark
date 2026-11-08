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

test("native NEAR selector lists the configured wallet modules", async ({ page }) => {
  await page.goto("/connect-wallet");
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /Connect NEAR Wallet/ }).click();
  await expect(page.getByText("Meteor Wallet", { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("MyNearWallet", { exact: true })).toBeVisible();
});

test("mobile marketplace remains readable", async ({ page }) => {
  await page.goto("/marketplace");
  await page.waitForTimeout(3000);
  await expect(page.locator("body")).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("marketplace search and studio service feedback are interactive", async ({ page }) => {
  await page.goto("/marketplace");
  await page.waitForTimeout(3000);
  await expect(page.getByRole("button", { name: "All strategies" })).toHaveClass(/q-category-active/);
  const category = page.getByRole("button", { name: "Crypto spot" });
  await category.click();
  await expect(category).toHaveClass(/q-category-active/);
  const search = page.getByRole("textbox", { name: "Search strategies" });
  await search.fill("no-method-matches-this-query");
  await expect(search).toHaveValue("no-method-matches-this-query");

  await page.goto("/studio");
  await page.getByPlaceholder("For example, Atlas range break").fill("Browser verification strategy");
  await page.getByRole("button", { name: /Test my strategy/ }).click();
  await expect(page.locator("body")).toContainText(/Simulation complete|could not|not configured/i, { timeout: 15000 });
});
