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
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto("/connect-wallet");
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /Connect NEAR Wallet/ }).click();
  await expect(page.getByText("Meteor Wallet", { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("MyNearWallet", { exact: true })).toBeVisible();
  expect(runtimeErrors.filter((message) => /buffer|KeyPairEd25519/i.test(message))).toEqual([]);
});

test("mobile marketplace remains readable", async ({ page }) => {
  await page.goto("/marketplace");
  await page.waitForTimeout(3000);
  await expect(page.locator("body")).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("production asset URLs return files with correct MIME types", async ({ request }) => {
  const origin = process.env.PRODUCTION_BASE_URL || "http://127.0.0.1:3000";
  const document = await request.get(origin);
  expect(document.status()).toBe(200);
  const html = await document.text();
  const stylesheet = html.match(/(?:href|src)=["']([^"']+\.css)["']/)?.[1];
  const script = html.match(/(?:href|src)=["']([^"']+\.js)["']/)?.[1];
  expect(stylesheet).toBeTruthy();
  expect(script).toBeTruthy();
  const css = await request.get(new URL(stylesheet!, origin).toString());
  const js = await request.get(new URL(script!, origin).toString());
  expect(css.status()).toBe(200);
  expect(css.headers()["content-type"]).toMatch(/text\/css/);
  expect(js.status()).toBe(200);
  expect(js.headers()["content-type"]).toMatch(/javascript/);
});

test("marketplace search and studio service feedback are interactive", async ({ page }) => {
  await page.goto("/marketplace");
  await page.waitForTimeout(3000);
  await expect(page.getByRole("button", { name: "All strategies" })).toHaveClass(/q-category-active/);
  const category = page.locator(".q-category-row button").nth(1);
  await category.click();
  await expect(category).toHaveClass(/q-category-active/);
  const search = page.getByRole("textbox", { name: "Search strategies" });
  await search.fill("no-method-matches-this-query");
  await expect(search).toHaveValue("no-method-matches-this-query");

  await page.goto("/studio");
  await page.getByRole("textbox", { name: "What would you like your strategy to do?" }).fill("Browser verification strategy");
  await page.getByRole("button", { name: /Test my strategy/ }).click();
  await expect(page.locator("body")).toContainText(/Your strategy results|Testing your strategy|could not|not configured/i, { timeout: 30000 });
});
