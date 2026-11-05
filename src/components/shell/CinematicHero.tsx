import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CinematicHeroProps {
  image: string;
  imagePosition?: string;
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  chrome?: ReactNode;
  className?: string;
  /**
   * "text-protect" (default, legacy): stacked scrims darken the whole image
   * so bare text stays legible. Used by every existing route.
   * "dissolve-bottom": art runs high-contrast at the top and dissolves to
   * pure #000 only in the bottom 30%. Requires `glassText` for legibility.
   */
  scrimVariant?: "text-protect" | "dissolve-bottom";
  /**
   * Wraps the text block in a backdrop-blur glass plate with a top-edge
   * highlight. Use with scrimVariant="dissolve-bottom" so the art can
   * breathe while type stays readable.
   *   true / "wide" — legacy plate, spans up to max-w-60% at lg (wide fog).
   *   "tight"       — plate hugs the text intrinsically (inline-block w-fit),
   *                   letting the art breathe around it. Used on Home.
   */
  glassText?: boolean | "wide" | "tight";
  /**
   * Per-page hero accent for the eyebrow and any inline accent spans.
   * Falls back to the global --accent (violet) which is otherwise
   * RESERVED for actions. Pass a color pulled from the artwork so the
   * type harmonises with the image instead of fighting it.
   */
  heroAccent?: string;
}

/**
 * CinematicHero — one hero primitive, two moods.
 *
 *  Layers (bottom → top):
 *    1. Full-bleed art (280 / 340 / 400px), object-cover, top-anchored
 *    2. Scrim stack (variant-dependent)
 *    3. Chrome slot (avatar, back button) with pointer-events restored
 *    4. Text block, bottom-left, optionally on a glass plate
 */
export function CinematicHero({
  image,
  imagePosition = "center top",
  eyebrow,
  title,
  subtitle,
  chrome,
  className,
  scrimVariant = "text-protect",
  glassText = false,
  heroAccent,
}: CinematicHeroProps) {
  const accentColor = heroAccent ?? "var(--accent)";

  // Scrim geometry per variant.
  const verticalScrim =
    scrimVariant === "dissolve-bottom"
      ? "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.35) 80%, rgba(0,0,0,0.80) 94%, #000000 100%)"
      : "linear-gradient(180deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0.80) 90%, #000000 100%)";


  const showRadial = scrimVariant === "text-protect";

  return (
    <section
      className={cn(
        "relative w-full overflow-hidden bg-black",
        "h-[280px] md:h-[340px] lg:h-[400px]",
        className,
      )}
    >
      {/* Layer 1 — full-bleed art */}
      <img
        src={image}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover"
        style={{ objectPosition: imagePosition }}
        onError={(event) => {
          event.currentTarget.hidden = true;
        }}
      />

      {/* Layer 2a — vertical scrim */}
      <div aria-hidden className="absolute inset-0" style={{ background: verticalScrim }} />

      {/* Layer 2b — left radial vignette (text-protect only) */}
      {showRadial && (
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(80% 100% at 0% 60%, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.10) 45%, transparent 70%)",

          }}
        />
      )}

      {/* Layer 3 — chrome */}
      {chrome && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
          <div className="pointer-events-auto">{chrome}</div>
        </div>
      )}

      {/* Layer 4 — text block, bottom-left */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-4 pb-6 md:px-8 md:pb-8 lg:px-12 lg:pb-10">
        <div
          className={cn(
            !glassText && "max-w-[85%] md:max-w-[70%] lg:max-w-[60%]",
            glassText === true || glassText === "wide"
              ? "inline-block max-w-full rounded-3xl px-5 py-4 md:px-6 md:py-5"
              : null,
            glassText === "tight" &&
              "inline-block w-fit max-w-[92%] rounded-2xl px-4 py-3 md:px-5 md:py-4 md:max-w-[80%] lg:max-w-[65%]",
          )}
          style={
            glassText
              ? {
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.045) 100%)",
                  backdropFilter: "blur(24px) saturate(140%)",
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,0.14), 0 24px 60px -30px rgba(0,0,0,0.75)",
                }
              : undefined
          }
        >
          {eyebrow && (
            <p
              className="mb-2 text-[13px] font-semibold uppercase text-float"
              style={{ letterSpacing: "0.15em", color: accentColor }}
            >
              {eyebrow}
            </p>
          )}
          <h1
            className="text-[40px] font-bold leading-[1.02] text-white md:text-[48px] lg:text-[56px] text-float"
            style={{ letterSpacing: "-0.02em", ["--hero-accent" as string]: accentColor }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="mt-3 text-[15px] leading-relaxed text-white/90 md:text-[16px]">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
