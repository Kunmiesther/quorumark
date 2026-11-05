// @vitest-environment node
import { expect, it } from "vitest";
import { BLOCKCHAINS } from "./catalog";
import { inspectNetworkWallet } from "./readiness.server";
import { probeSynFuturesSdk } from "../exchanges/synfutures/probe.server";
import { quoteSynFuturesMarket } from "../exchanges/synfutures/marketQuote.server";

// Opt-in, public reads only. Never signs, approves, submits or moves funds.
it.skipIf(process.env.RUN_PUBLIC_CHAIN_CHECKS !== "1")(
  "reads all public mainnets and a discovered SynFutures quote",
  async () => {
    for (const network of BLOCKCHAINS) {
      const result = await inspectNetworkWallet(network, {
        id: "public-smoke",
        provider: "manual",
        label: null,
        network: "mainnet",
        status: "verified",
        is_active: true,
        chain: network.family === "evm" ? "ethereum" : "solana",
        public_address:
          network.family === "evm"
            ? "0x0000000000000000000000000000000000000001"
            : "11111111111111111111111111111111",
      });
      expect(result.execution_ready).toBe(false);
      console.info(`${network.name}: mainnet identity and balance read passed`);
    }
    const probe = await probeSynFuturesSdk();
    expect(probe.observer_read_compatible).toBe(true);
    const market = probe.markets.find(
      (m) => m.symbol.startsWith("BTC") && m.expiries.includes(4294967295),
    );
    expect(market).toBeDefined();
    for (const side of ["short", "long"] as const) {
      // Respect the public endpoint's request budget after registry discovery.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const quote = await quoteSynFuturesMarket(
        { instrument: market!.instrument, expiry: 4294967295, notional: "100", side },
        probe,
      );
      expect(Number(quote.base_size)).toBeGreaterThan(0);
      console.info(`SynFutures ${market!.symbol} ${side}: quote read passed`);
    }
  },
  120_000,
);
