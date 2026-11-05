import { useEffect, useState, useCallback } from "react";
import {
  readNetworkMode,
  writeNetworkMode,
  type NetworkMode,
} from "@/lib/app-env";

/**
 * Client-only Testnet/Mainnet selector. Server-side gates ignore this value —
 * it drives UI copy, the LIVE MAINNET banner, and which reads are shown.
 * Never gates order execution.
 */
export function useNetworkMode(): {
  mode: NetworkMode;
  setMode: (m: NetworkMode) => void;
  hydrated: boolean;
} {
  const [hydrated, setHydrated] = useState(false);
  const [mode, setModeState] = useState<NetworkMode>("testnet");

  useEffect(() => {
    setModeState(readNetworkMode());
    setHydrated(true);
  }, []);

  const setMode = useCallback((m: NetworkMode) => {
    writeNetworkMode(m);
    setModeState(m);
  }, []);

  return { mode, setMode, hydrated };
}
