import { ShieldAlert } from "lucide-react";
import {
  APP_ENV,
  EXECUTION_ENABLED,
  MAINNET_READONLY_BANNER_TEXT,
  TEST_MODE_BANNER_TEXT,
} from "@/lib/app-env";

/**
 * Persistent, non-dismissible banner that renders on every authenticated
 * trading screen while execution is disabled. Backed by the central
 * app-env config; the backend enforces execution-disabled independently.
 *
 * Copy is derived from APP_ENV so the banner cannot say "TEST" while the
 * app is pointed at mainnet reads.
 */
export function TestModeBanner() {
  if (EXECUTION_ENABLED) return null;
  const isMainnetReadonly = APP_ENV === "mainnet_readonly";
  const title = isMainnetReadonly
    ? MAINNET_READONLY_BANNER_TEXT
    : TEST_MODE_BANNER_TEXT;
  const subtitle = isMainnetReadonly
    ? "Balances and positions are live mainnet reads. Order submission remains disabled."
    : "Credentials stay encrypted. Verification is read-only until a later phase.";
  const toneBorder = isMainnetReadonly
    ? "border-red-400/30"
    : "border-amber-400/30";
  const toneBg = isMainnetReadonly
    ? "bg-red-400/[0.08]"
    : "bg-amber-400/[0.08]";
  const iconBg = isMainnetReadonly
    ? "bg-red-400/15 text-red-300"
    : "bg-amber-400/15 text-amber-300";
  return (
    <div
      role="status"
      aria-live="polite"
      data-app-env={APP_ENV}
      className={`mx-5 mt-1 mb-2 flex items-center gap-3 rounded-2xl border ${toneBorder} ${toneBg} px-3.5 py-2.5`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${iconBg}`}
      >
        <ShieldAlert className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold leading-tight text-foreground">
          {title}
        </p>
        <p className="mt-0.5 text-[10.5px] leading-tight text-muted-foreground">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

