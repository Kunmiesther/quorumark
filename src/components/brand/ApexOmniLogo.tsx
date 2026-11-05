import { apexOmniLogo } from "@/lib/venue-logos";

type Size = "sm" | "md" | "lg";

const HEIGHTS: Record<Size, string> = {
  sm: "h-4",   // 16px
  md: "h-5",   // 20px
  lg: "h-7",   // 28px
};

/**
 * Official ApeX Omni gorilla-head emblem. Aspect-preserved, consistent sizing,
 * accessible alt text. Use to identify the venue, never as background
 * decoration.
 */
export function ApexOmniLogo({
  size = "md",
  className = "",
}: {
  size?: Size;
  className?: string;
}) {
  return (
    <img
      src={apexOmniLogo}
      alt="ApeX Omni"
      className={`${HEIGHTS[size]} w-auto shrink-0 select-none ${className}`}
      draggable={false}
    />
  );
}
