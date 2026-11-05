import type { Direction } from "./signal";
import type { HtfBosState } from "./htfBos";

export interface SetupTimeframeInput {
  direction: Direction;
  oneHourAvailable: boolean;
  fourHourAvailable: boolean;
  oneHourBos: HtfBosState;
  fourHourBos: HtfBosState;
  executionTsMs?: number;
  oneHourTsMs?: number | null;
  fourHourTsMs?: number | null;
}

export interface SetupTimeframeDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Fail-closed setup policy for NEW entries.
 *
 * Both native setup feeds must be present. A recent confirmed BOS on either
 * setup timeframe may be neutral ("none"), but it may never oppose the
 * proposed 15-minute execution direction. This lets 1h and 4h qualify the
 * setup without requiring two simultaneous BOS events, which would make the
 * strategy effectively inert.
 */
export function evaluateSetupTimeframes(input: SetupTimeframeInput): SetupTimeframeDecision {
  if (!input.oneHourAvailable || !input.fourHourAvailable) {
    const missing = [!input.oneHourAvailable ? "1h" : null, !input.fourHourAvailable ? "4h" : null]
      .filter(Boolean)
      .join("+");
    return { allowed: false, reason: `missing native ${missing} setup feed` };
  }

  if (input.executionTsMs != null) {
    const frames = [
      { label: "1h", ts: input.oneHourTsMs, maxAge: 2 * 60 * 60_000 },
      { label: "4h", ts: input.fourHourTsMs, maxAge: 8 * 60 * 60_000 },
    ];
    for (const frame of frames) {
      if (frame.ts == null || frame.ts > input.executionTsMs) {
        return { allowed: false, reason: `${frame.label} setup timestamp is invalid` };
      }
      if (input.executionTsMs - frame.ts > frame.maxAge) {
        return { allowed: false, reason: `${frame.label} setup feed is stale` };
      }
    }
  }

  const opposing: HtfBosState = input.direction === "long" ? "bearish_bos" : "bullish_bos";
  if (input.fourHourBos === opposing) {
    return { allowed: false, reason: `4h setup opposes ${input.direction}` };
  }
  if (input.oneHourBos === opposing) {
    return { allowed: false, reason: `1h setup opposes ${input.direction}` };
  }
  return {
    allowed: true,
    reason: `1h=${input.oneHourBos}; 4h=${input.fourHourBos}; aligned with ${input.direction}`,
  };
}
