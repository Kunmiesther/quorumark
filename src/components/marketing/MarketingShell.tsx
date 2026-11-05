import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { brand, riskDisclosure } from "@/lib/marketing/data";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { to: "/", label: "Home" },
  { to: "/whitepaper", label: "Whitepaper" },
  { to: "/roadmap", label: "Roadmap" },
  { to: "/presale", label: "Presale" },
  { to: "/nfts", label: "NFTs" },
  { to: "/merch", label: "Merch" },
] as const;

/**
 * Public marketing shell. Wraps every public page in a consistent
 * cinematic frame: fixed backdrop, glass nav, and unified footer.
 * Does NOT touch the authenticated app — the shell is scoped to public
 * routes only and never renders inside /_authenticated/*.
 */
export function MarketingShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#05060A] text-white">
      <BackgroundLayers />
      <TopNav />
      <main className={cn("relative z-10", className)}>{children}</main>
      <Footer />
    </div>
  );
}

function BackgroundLayers() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(93,63,211,0.28),transparent_55%),radial-gradient(ellipse_at_bottom,rgba(0,191,255,0.18),transparent_60%)]" />
      <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:80px_80px]" />
      <div className="absolute inset-x-0 top-0 h-[520px] bg-gradient-to-b from-black/40 via-transparent to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-[420px] bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
    </div>
  );
}

function TopNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-black/50 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-2">
          <img
            src={brand.wordmark}
            alt="TurtleBot"
            className="h-7 w-auto sm:h-8"
            loading="eager"
            decoding="async"
          />
        </Link>
        <nav
          aria-label="Primary"
          className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-1 py-1 text-sm backdrop-blur md:flex"
        >
          {NAV_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: true }}
              className="rounded-full px-3 py-1.5 text-white/70 transition-colors hover:text-white"
              activeProps={{ className: "!text-white bg-white/10" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            to="/auth"
            className="hidden text-sm text-white/70 transition-colors hover:text-white sm:inline"
          >
            Sign in
          </Link>
          <Link
            to="/home"
            className="inline-flex items-center rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.03]"
          >
            Launch App
          </Link>
        </div>
      </div>
      <MobileNav />
    </header>
  );
}

function MobileNav() {
  return (
    <nav
      aria-label="Primary mobile"
      className="mx-auto flex w-full max-w-7xl items-center gap-1 overflow-x-auto px-3 pb-2 pt-1 text-xs md:hidden"
    >
      {NAV_LINKS.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: true }}
          className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-white/70"
          activeProps={{ className: "!text-white bg-white/15 border-white/25" }}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function Footer() {
  return (
    <footer className="relative z-10 border-t border-white/[0.06] bg-black/60 backdrop-blur-xl">
      <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-5 lg:px-8">
        <div className="md:col-span-2">
          <img src={brand.wordmark} alt="TurtleBot" className="h-8 w-auto" />
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/60">
            TurtleBot is a non-custodial trading platform coordinated by the Onyx intelligence
            layer. We can trade in your connected account. We can never withdraw.
          </p>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.24em] text-white/50">
            Ecosystem
          </h3>
          <ul className="mt-4 space-y-2 text-sm text-white/70">
            <li>
              <Link to="/whitepaper" className="hover:text-white">
                Whitepaper
              </Link>
            </li>
            <li>
              <Link to="/roadmap" className="hover:text-white">
                Roadmap
              </Link>
            </li>
            <li>
              <Link to="/presale" className="hover:text-white">
                Presale
              </Link>
            </li>
            <li>
              <Link to="/nfts" className="hover:text-white">
                NFT Collections
              </Link>
            </li>
            <li>
              <Link to="/merch" className="hover:text-white">
                Merch
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.24em] text-white/50">
            App
          </h3>
          <ul className="mt-4 space-y-2 text-sm text-white/70">
            <li>
              <Link to="/auth" className="hover:text-white">
                Sign in
              </Link>
            </li>
            <li>
              <Link to="/home" className="hover:text-white">
                Launch App
              </Link>
            </li>
            <li>
              <Link to="/pricing" className="hover:text-white">
                Plans
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.24em] text-white/50">
            Legal
          </h3>
          <ul className="mt-4 space-y-2 text-sm text-white/70">
            <li>
              <Link to="/privacy" className="hover:text-white">
                Privacy Policy
              </Link>
            </li>
            <li>
              <Link to="/terms" className="hover:text-white">
                Terms of Service
              </Link>
            </li>
            <li>
              <Link to="/risk-disclosure" className="hover:text-white">
                Risk Disclosure
              </Link>
            </li>
            <li>
              <Link to="/data-deletion" className="hover:text-white">
                Data Deletion
              </Link>
            </li>
            <li>
              <Link to="/social-auth" className="hover:text-white">
                Social Login
              </Link>
            </li>
            <li>
              <Link to="/support" className="hover:text-white">
                Support
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-[11px] leading-relaxed text-white/50">
          <p>
            <strong className="font-semibold text-white/70">Risk notice.</strong> {riskDisclosure}
          </p>
          <p className="mt-2">
            © {new Date().getFullYear()} TurtleBot. Powered by Onixus AI. All product names and
            phases marked "Planned", "In development", or "Target" are forward-looking and subject
            to change.
          </p>
        </div>
      </div>
    </footer>
  );
}
