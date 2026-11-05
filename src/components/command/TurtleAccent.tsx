import { CSSProperties } from "react";
import { turtleAccent } from "@/lib/turtles";

/** Returns inline CSS variables carrying a turtle's accent, resolved
 *  from `turtles.ts`. Never reads `strategies.ring_color`. */
export function turtleAccentStyle(slug: string): CSSProperties {
  const accent = turtleAccent(slug);
  return {
    // Expose as CSS variables so consumers can drive borders/glows/text.
    ["--turtle-accent" as string]: accent,
    color: accent,
  };
}

interface TurtleAccentProps {
  slug: string;
  as?: "span" | "div";
  className?: string;
  children?: React.ReactNode;
}

/** Tiny helper element whose color/CSS var is set from the turtle's accent. */
export function TurtleAccent({ slug, as = "span", className, children }: TurtleAccentProps) {
  const Tag = as as "span";
  return (
    <Tag className={className} style={turtleAccentStyle(slug)}>
      {children}
    </Tag>
  );
}
