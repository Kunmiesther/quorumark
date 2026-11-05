import { useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

export function BackButton({
  fallback = "/home",
  label = "Back",
  iconOnly = false,
  className = "",
}: {
  fallback?: string;
  label?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const navigate = useNavigate();

  function onBack() {
    // Never send a customer out of TurtleBot just because the browser has
    // history. Use history only when this tab entered from TurtleBot itself.
    let cameFromTurtleBot = false;
    if (typeof window !== "undefined" && document.referrer) {
      try {
        cameFromTurtleBot = new URL(document.referrer).origin === window.location.origin;
      } catch {
        cameFromTurtleBot = false;
      }
    }
    if (cameFromTurtleBot && window.history.length > 1 && router.history.length > 1) {
      router.history.back();
    } else {
      navigate({ to: fallback });
    }
  }

  return (
    <button
      type="button"
      onClick={onBack}
      aria-label={label}
      title={label}
      className={`tb-neu-raised flex h-11 items-center justify-center gap-1 rounded-full text-sm font-medium text-foreground/85 transition hover:text-white active:scale-[0.96] ${iconOnly ? "w-11 p-0" : "px-3"} ${className}`}
    >
      <ChevronLeft className="h-5 w-5" />
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}
