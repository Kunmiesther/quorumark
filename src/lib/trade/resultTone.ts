export const RESULT_TONES = {
  neutral: { text: "text-white/85", surface: "border-white/[0.07]" },
  positive: { text: "text-emerald-300", surface: "border-emerald-300/20" },
  negative: { text: "text-rose-300", surface: "border-rose-300/20" },
  info: { text: "text-cyan-200", surface: "border-cyan-300/15" },
} as const;
export type ResultTone = keyof typeof RESULT_TONES;
/** Unknown and zero results are not presented as wins. Labels/signs retain meaning without color. */
export function resultTone(value: number | null): ResultTone {
  if (value == null || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}
