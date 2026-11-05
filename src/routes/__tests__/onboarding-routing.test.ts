// Static source-level guardrails for the onboarding auth/routing contract.
//
// The project's test harness has no React renderer / router test utils
// installed (no @testing-library/react). Rather than scaffold a heavy new
// framework just for these behavioural checks, we assert the routing
// contract by inspecting the route source. Each assertion here maps 1:1
// to a behavioural acceptance criterion from the auth-hardening phase.
//
// Skipped (with reasons):
//  - Full render of PIN / wallet routes with a mocked useAuth to observe
//    the redirect DOM: needs @testing-library/react + router harness that
//    the project does not ship. Instead we assert the guard code is
//    present and structured correctly.
//  - Live wallet verification round-trip: covered by the existing
//    src/lib/wallet/verification-flow.test.ts state-machine tests.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const PIN = read("src/routes/welcome.pin.tsx");
const PIN_CONFIRM = read("src/routes/welcome.pin-confirm.tsx");
const WALLET = read("src/routes/welcome.wallet.tsx");
const EXCHANGE = read("src/routes/welcome.exchange.tsx");
const AUTH = read("src/routes/auth.tsx");
const WELCOME_LAYOUT = read("src/routes/welcome.tsx");

describe("onboarding auth guards (source contract)", () => {
  it("welcome.pin: unauthenticated users are redirected to /welcome and no protected UI renders", () => {
    expect(PIN).toMatch(/if\s*\(\s*!loading\s*&&\s*!user\s*\)\s*navigate\(\s*\{\s*to:\s*"\/welcome"\s*\}\s*\)/);
    // Guard returns null before the PIN keypad ever mounts.
    expect(PIN).toMatch(/if\s*\(\s*loading\s*\|\|\s*!user\s*\)\s*return\s+null/);
  });

  it("welcome.pin-confirm: unauthenticated users are redirected to /welcome and no protected UI renders", () => {
    expect(PIN_CONFIRM).toMatch(/if\s*\(\s*!loading\s*&&\s*!user\s*\)\s*navigate\(\s*\{\s*to:\s*"\/welcome"\s*\}\s*\)/);
    expect(PIN_CONFIRM).toMatch(/if\s*\(\s*loading\s*\|\|\s*!user\s*\)\s*return\s+null/);
  });

  it("welcome.wallet: unauthenticated users are redirected to /welcome and no protected UI renders", () => {
    expect(WALLET).toMatch(/if\s*\(\s*!loading\s*&&\s*!user\s*\)\s*navigate\(\s*\{\s*to:\s*"\/welcome"\s*\}\s*\)/);
    expect(WALLET).toMatch(/if\s*\(\s*loading\s*\|\|\s*!user\s*\)\s*return\s+null/);
  });
});

describe("auth.tsx signup routing", () => {
  it("signup without a returned session shows confirm-email toast and does NOT navigate to /welcome/pin", () => {
    // navigate to /welcome/pin must be gated on `if (data.session)`.
    expect(AUTH).toMatch(/if\s*\(\s*data\.session\s*\)\s*\{[\s\S]{0,120}?navigate\(\s*\{\s*to:\s*"\/welcome\/pin"\s*\}\s*\)/);
    // The no-session branch: confirm-email toast + switch to signin mode.
    expect(AUTH).toMatch(/toast\.success\(\s*"Account created\. Please confirm your email[^"]*"\s*\)/);
    expect(AUTH).toMatch(/setMode\(\s*"signin"\s*\)/);
    // Sanity: exactly ONE navigate-to-pin call anywhere in the file (the guarded one).
    const pinNavs = AUTH.match(/navigate\(\s*\{\s*to:\s*"\/welcome\/pin"\s*\}\s*\)/g) ?? [];
    expect(pinNavs.length).toBe(1);
  });
});

describe("welcome.exchange routing to wallet step", () => {
  it("both connect-success and skip navigate to /welcome/wallet", () => {
    const walletNavs = EXCHANGE.match(/navigate\(\s*\{\s*to:\s*"\/welcome\/wallet"\s*\}\s*\)/g) ?? [];
    expect(walletNavs.length).toBeGreaterThanOrEqual(2);
    // Old destinations must not be re-introduced from the exchange step.
    expect(EXCHANGE).not.toMatch(/navigate\(\s*\{\s*to:\s*"\/welcome\/notifications"\s*\}\s*\)/);
    expect(EXCHANGE).not.toMatch(/navigate\(\s*\{\s*to:\s*"\/welcome\/face-id"\s*\}\s*\)/);
  });
});

describe("welcome.wallet forward navigation", () => {
  it("only navigates to /welcome/notifications after successful server verification", () => {
    // Order across the whole file: the wallet-verify call happens before the
    // guarded WalletError throw, which happens before the success navigate.
    const verifyIdx = WALLET.indexOf('supabase.functions.invoke("wallet-verify"');
    const throwIdx = WALLET.indexOf("result?.code ?? \"VERIFY_FAILED\"");
    const navIdx = WALLET.indexOf('navigate({ to: "/welcome/notifications" })');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeGreaterThan(verifyIdx);
    expect(navIdx).toBeGreaterThan(throwIdx);
  });

  it("skip navigates forward without creating a wallet record (no supabase writes in skip())", () => {
    // Grab from `function skip()` up to the next top-level `function ` declaration.
    const start = WALLET.indexOf("function skip()");
    expect(start).toBeGreaterThan(-1);
    const rest = WALLET.slice(start);
    const nextFn = rest.indexOf("\nfunction ", 1);
    const body = nextFn > -1 ? rest.slice(0, nextFn) : rest;
    expect(body).toMatch(/navigate\(\s*\{\s*to:\s*"\/welcome\/notifications"\s*\}\s*\)/);
    // No DB / edge-function calls in the skip path.
    expect(body).not.toMatch(/supabase\.(from|functions|auth)/);
    expect(body).not.toMatch(/wallet-(challenge|verify)/);
  });
});

describe("welcome history navigation", () => {
  it("only reveals forward navigation for a previously visited step", () => {
    expect(WELCOME_LAYOUT).toContain('const MAX_VISITED_KEY = "tb_onboarding_max_visited"');
    expect(WELCOME_LAYOUT).toMatch(/if\s*\(\s*currentStep\s*<\s*0\s*\|\|\s*currentStep\s*>=\s*maxVisited\s*\)\s*return/);
    expect(WELCOME_LAYOUT).toMatch(/currentStep\s*<\s*maxVisited/);
  });
});
