import { useEffect } from "react";
import { turtleBySlug, turtleImage } from "@/lib/turtles";

export function Mascot({
  size = 180,
  src,
  slug = "dca",
}: {
  size?: number;
  src?: string;
  slug?: string;
}) {
  const image = src ?? turtleImage(slug);
  const accent = turtleBySlug(slug)?.accent ?? "#A855F7";

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".welcome-shell")
      ?? document.querySelector<HTMLElement>(".auth-shell");
    if (!shell) return;

    shell.dataset.turtleTheme = slug;
    shell.style.setProperty("--welcome-accent", accent);
    shell.style.setProperty("--welcome-accent-soft", `color-mix(in srgb, ${accent} 68%, white)`);
    shell.style.setProperty("--welcome-accent-dark", `color-mix(in srgb, ${accent} 68%, black)`);

    return () => {
      if (shell.dataset.turtleTheme === slug) {
        delete shell.dataset.turtleTheme;
        shell.style.removeProperty("--welcome-accent");
        shell.style.removeProperty("--welcome-accent-soft");
        shell.style.removeProperty("--welcome-accent-dark");
      }
    };
  }, [accent, slug]);
  const maxWidth = Math.min(225, Math.max(190, Math.round(size * 1.18)));
  const height = Math.round(maxWidth * 1.28);
  const objectPosition: Record<string, string> = {
    dca: "50% 16%",
    "rsi-divergence": "50% 14%",
    "ema-cross": "50% 12%",
    "break-retest": "50% 14%",
    "liq-hunting": "50% 13%",
  };
  return (
    <div
      className="welcome-turtle-widget relative mx-auto w-full overflow-hidden rounded-[30px]"
      style={{ maxWidth, height }}
      aria-hidden
    >
      <img src={image} alt="" decoding="async" className="h-full w-full object-cover" style={{ objectPosition: objectPosition[slug] ?? "50% 14%" }} />
      <div className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_1px_0_rgba(255,255,255,.14),inset_0_-24px_34px_rgba(5,5,10,.28)]" />
    </div>
  );
}
