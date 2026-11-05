import { useEffect, useState } from "react";

/**
 * Returns true when the OS reports `prefers-reduced-motion: reduce`.
 * Used to gate parallax, particle drift, and one-shot scans on the
 * command-world surfaces. Reduced-motion is also enforced globally by
 * the @media rule in src/styles.css.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reduced;
}
