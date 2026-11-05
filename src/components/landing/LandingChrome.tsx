import { useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { brand, riskDisclosure } from "@/lib/marketing/data";

type NavItem = { label: string; href: string; external?: boolean };

const NAV: NavItem[] = [
  { label: "Story", href: "#story" },
  { label: "Life Map", href: "#life-map" },
  { label: "Meet the Turtles", href: "#turtles" },
  { label: "Trading", href: "#trading" },
  { label: "NFTs", href: "#nfts" },
  { label: "Roadmap", href: "/roadmap", external: true },
  { label: "Whitepaper", href: "/whitepaper", external: true },
];

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-purple-400/15 bg-[#09090f]/85 shadow-[0_12px_36px_-24px_rgba(168,85,247,0.65)] backdrop-blur-xl"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
        <Link to="/" className="flex items-center gap-2 shrink-0">
          <img
            src={brand.wordmark}
            alt="TurtleBot"
            className="h-12 w-auto sm:h-14"
            loading="eager"
            decoding="async"
          />
        </Link>

        <nav
          aria-label="Primary"
          className="hidden items-center gap-1 xl:flex"
        >
          {NAV.map((item) =>
            item.external ? (
              <Link
                key={item.label}
                to={item.href}
                className="rounded-full px-3 py-1.5 text-[13px] font-medium text-white/70 transition-colors hover:text-white"
              >
                {item.label}
              </Link>
            ) : (
              <a
                key={item.label}
                href={item.href}
                className="rounded-full px-3 py-1.5 text-[13px] font-medium text-white/70 transition-colors hover:text-white"
              >
                {item.label}
              </a>
            ),
          )}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            to="/auth"
            className="hidden text-[13px] font-medium text-white/70 transition-colors hover:text-white sm:inline"
          >
            Sign In
          </Link>
          <Link
            to="/welcome"
            className="landing-neo-button landing-neo-button-primary inline-flex items-center rounded-full px-4 py-2 text-[13px] font-semibold text-white transition-transform hover:scale-[1.02]"
          >
            Enter App
          </Link>
          <button
            aria-label="Open menu"
            className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/80 xl:hidden"
            onClick={() => setOpen(true)}
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-[60] xl:hidden">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-xl"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-white/10 bg-[#05060A] px-6 py-5">
            <div className="mb-8 flex items-center justify-between">
              <img src={brand.wordmark} alt="TurtleBot" className="h-6 w-auto" />
              <button
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex flex-col gap-1">
              {NAV.map((item) =>
                item.external ? (
                  <Link
                    key={item.label}
                    to={item.href}
                    onClick={() => setOpen(false)}
                    className="rounded-xl px-3 py-3 text-base font-medium text-white/85 transition-colors hover:bg-white/[0.06]"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <a
                    key={item.label}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="rounded-xl px-3 py-3 text-base font-medium text-white/85 transition-colors hover:bg-white/[0.06]"
                  >
                    {item.label}
                  </a>
                ),
              )}
            </nav>
            <div className="mt-auto flex flex-col gap-2 pt-6">
              <Link
                to="/auth"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] text-sm font-semibold text-white"
              >
                Sign In
              </Link>
              <Link
                to="/welcome"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 items-center justify-center rounded-full bg-white text-sm font-semibold text-black"
              >
                Enter App
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

export function LandingFooter() {
  return (
    <footer className="relative z-10 border-t border-white/[0.06] bg-black">
      <div className="mx-auto grid w-full max-w-7xl gap-10 px-5 py-16 sm:grid-cols-2 sm:px-8 lg:grid-cols-5">
        <div className="md:col-span-2">
          <img src={brand.wordmark} alt="TurtleBot" className="h-7 w-auto" />
          <p className="mt-5 max-w-md text-sm leading-relaxed text-white/55">
            An AI operating system for everyday people. Non-custodial by design —
            TurtleBot can trade in accounts you connect. TurtleBot can never
            withdraw.
          </p>
        </div>
        <FooterCol
          title="Product"
          items={[
            { label: "Life Map", href: "#life-map" },
            { label: "Meet the Turtles", href: "#turtles" },
            { label: "Trading", href: "#trading" },
          ]}
        />
        <FooterCol
          title="Ecosystem"
          items={[
            { label: "NFT Drops", href: "#nfts" },
            { label: "Whitepaper", href: "/whitepaper", route: true },
            { label: "Roadmap", href: "/roadmap", route: true },
            { label: "Sign In", href: "/auth", route: true },
          ]}
        />
        <FooterCol
          title="Legal"
          items={[
            { label: "Privacy Policy", href: "/privacy", route: true },
            { label: "Terms of Service", href: "/terms", route: true },
            { label: "Risk Disclosure", href: "/risk-disclosure", route: true },
            { label: "Data Deletion", href: "/data-deletion", route: true },
            { label: "Social Login", href: "/social-auth", route: true },
            { label: "Support", href: "/support", route: true },
          ]}
        />
      </div>
      <div className="mx-auto w-full max-w-7xl px-5 pb-10 sm:px-8">
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 text-[11px] leading-relaxed text-white/45">
          <p>
            <strong className="font-semibold text-white/70">Risk notice.</strong>{" "}
            {riskDisclosure}
          </p>
          <p className="mt-2">
            © {new Date().getFullYear()} TurtleBot. Powered by Onixus AI. Items
            labeled Planned, In development, or Target are forward-looking and
            subject to change.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  items,
}: {
  title: string;
  items: { label: string; href: string; route?: boolean }[];
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.28em] text-white/45">
        {title}
      </h3>
      <ul className="mt-5 space-y-3 text-sm text-white/70">
        {items.map((i) => (
          <li key={i.label}>
            {i.route ? (
              <Link to={i.href} className="transition-colors hover:text-white">
                {i.label}
              </Link>
            ) : (
              <a href={i.href} className="transition-colors hover:text-white">
                {i.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
