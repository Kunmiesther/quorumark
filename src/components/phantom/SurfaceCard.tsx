import { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * SurfaceCard — the shared raised Neumorphic data surface primitive.
 * Its material and light direction are controlled by the global app shell.
 */
export function SurfaceCard({
  className,
  children,
  as: Tag = "div",
}: {
  className?: string;
  children?: ReactNode;
  as?: "div" | "section" | "article";
}) {
  return <Tag className={cn("tb-neu-panel rounded-3xl p-5", className)}>{children}</Tag>;
}
