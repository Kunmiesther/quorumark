export function PinDots({ filled, length = 6, shake }: { filled: number; length?: number; shake?: boolean }) {
  return (
    <div className={`flex items-center justify-center gap-3 ${shake ? "shake-x" : ""}`}>
      {Array.from({ length }).map((_, i) => (
        <span
          key={i}
          className={`h-3.5 w-3.5 rounded-full transition-all ${
            i < filled
              ? `pin-dot-filled ${shake ? "pin-dot-error" : ""}`
              : "bg-white/10 ring-1 ring-white/15"
          }`}
        />
      ))}
    </div>
  );
}
