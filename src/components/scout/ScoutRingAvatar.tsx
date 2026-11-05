import { cn } from "@/lib/utils";

/**
 * ScoutRingAvatar — circular avatar wrapped in a smoothly spinning
 * Onixus violet→blue gradient conic ring. Subtle luminous halo, no
 * garish glow. Used for the Scout on the Home page beside Onyx.
 */
interface Props {
  src: string;
  alt: string;
  size?: number;
  /** When false, ring stays static and dimmed. */
  active?: boolean;
  className?: string;
  onClick?: () => void;
}

export function ScoutRingAvatar({
  src,
  alt,
  size = 88,
  active = true,
  className,
  onClick,
}: Props) {
  const ringSize = size;
  const inner = size - 8;
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-label={onClick ? `${alt} — open` : undefined}
      className={cn(
        "relative inline-flex items-center justify-center rounded-full",
        onClick && "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9945FF]",
        className,
      )}
      style={{ width: ringSize, height: ringSize }}
    >
      {/* Luminous outer halo — soft, premium, not garish. */}
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-[-6px] rounded-full opacity-60 blur-xl"
          style={{
            background:
              "radial-gradient(circle, rgba(153,69,255,0.45) 0%, rgba(20,120,255,0.25) 55%, transparent 75%)",
          }}
        />
      )}
      {/* Spinning gradient ring */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full",
          active ? "animate-[spin_6s_linear_infinite]" : "opacity-40",
        )}
        style={{
          background:
            "conic-gradient(from 0deg, #9945FF, #6C63FF, #1E90FF, #22D3EE, #6C63FF, #9945FF)",
          WebkitMask:
            "radial-gradient(circle, transparent calc(50% - 3px), #000 calc(50% - 2px))",
          mask:
            "radial-gradient(circle, transparent calc(50% - 3px), #000 calc(50% - 2px))",
        }}
      />
      {/* Inner black gap */}
      <span
        aria-hidden
        className="absolute rounded-full bg-black"
        style={{ width: inner + 2, height: inner + 2 }}
      />
      {/* Image */}
      <img
        src={src}
        alt={alt}
        width={inner}
        height={inner}
        loading="eager"
        className={cn(
          "relative z-10 rounded-full object-cover object-center",
          !active && "opacity-70 grayscale",
        )}
        style={{ width: inner, height: inner }}
      />
    </Wrapper>
  );
}
