import { cn } from "@/lib/utils";

export function QuorumarkLogo({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <svg
        aria-label="Quorumark mark"
        role="img"
        viewBox="0 0 40 40"
        className={compact ? "h-8 w-8" : "h-10 w-10"}
      >
        <rect
          x="1"
          y="1"
          width="38"
          height="38"
          rx="11"
          fill="#101419"
          stroke="#38D9E6"
          strokeWidth="1.5"
        />
        <path
          d="M12 21a8 8 0 1 1 14.3 4.9L30 29.5"
          fill="none"
          stroke="#C7F36B"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <path
          d="M28 19a8 8 0 1 0-14.3 4.9L10 27.5"
          fill="none"
          stroke="#38D9E6"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <circle cx="20" cy="20" r="2.2" fill="#F1F0E8" />
      </svg>
      {!compact && (
        <span className="font-display text-lg font-semibold tracking-[0.08em] text-[#F1F0E8]">
          QUORUMARK
        </span>
      )}
    </span>
  );
}
