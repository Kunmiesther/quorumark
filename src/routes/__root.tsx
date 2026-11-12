import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, Link, type ErrorComponentProps } from "@tanstack/react-router";
import { lazy, Suspense, type ReactNode } from "react";
import appCss from "../styles.css?url";

const Toaster = lazy(() => import("@/components/ui/sonner").then((module) => ({ default: module.Toaster })));

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({ meta: [
    { charSet: "utf-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
    { name: "theme-color", content: "#101419" },
    { title: "Quorumark Strategy Exchange" },
  ], links: [
    { rel: "stylesheet", href: appCss },
    { rel: "icon", type: "image/svg+xml", href: "/quorumark-mark.svg?v=2" },
  ] }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: () => <main className="q-not-found"><h1>Page not found</h1><p>The exchange route you requested does not exist.</p><Link to="/marketplace" className="q-primary">Open marketplace</Link></main>,
  errorComponent: ({ error, reset }: ErrorComponentProps) => <main className="q-not-found"><h1>Something went wrong</h1><p>{error instanceof Error ? error.message : "The exchange could not load this view."}</p><button className="q-primary" onClick={reset}>Try again</button></main>,
});

function RootShell({ children }: { children: ReactNode }) { return <html lang="en"><head><HeadContent /></head><body className="min-h-screen bg-[#101419] text-[#f1f0e8] antialiased">{children}<Scripts/></body></html>; }
function RootComponent() { const { queryClient } = Route.useRouteContext(); return <QueryClientProvider client={queryClient}><Outlet/><Suspense fallback={null}><Toaster/></Suspense></QueryClientProvider>; }
