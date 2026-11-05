import { cn } from "@/lib/utils";

interface TurtleAvatarProps {
  src: string;
  ringColor: string;
  size?: number; // px
  className?: string;
  alt?: string;
  glow?: boolean;
}

export function TurtleAvatar({ src, ringColor, size = 80, className, alt = "", glow }: TurtleAvatarProps) {
  return (
    <div
      className={cn("relative shrink-0 rounded-full p-[3px]", className)}
      style={{
        width: size,
        height: size,
        background: `conic-gradient(from 140deg, ${ringColor}, ${ringColor}55, ${ringColor})`,
        boxShadow: glow ? `0 0 24px -4px ${ringColor}80` : undefined,
      }}
    >
      <div className="h-full w-full overflow-hidden rounded-full bg-inset">
        <img
          src={src}
          alt={alt}
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="h-full w-full scale-110 object-cover object-top"
        />
      </div>
    </div>
  );
}
