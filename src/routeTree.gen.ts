/* Generated route tree kept intentionally small for the Quorumark application. */
import { Route as RootRoute } from "./routes/__root";
import { Route as IndexRouteImport } from "./routes/index";
import { Route as AuthRouteImport } from "./routes/auth";
import { Route as ConnectWalletRouteImport } from "./routes/connect-wallet";
import { Route as FollowerRouteImport } from "./routes/follower";
import { Route as MarketplaceRouteImport } from "./routes/marketplace";
import { Route as MarketplaceSlugRouteImport } from "./routes/marketplace.$slug";
import { Route as PrivacyRouteImport } from "./routes/privacy";
import { Route as RiskDisclosureRouteImport } from "./routes/risk-disclosure";
import { Route as StudioRouteImport } from "./routes/studio";
import { Route as SubscriptionsRouteImport } from "./routes/subscriptions";
import { Route as TermsRouteImport } from "./routes/terms";
import { Route as VerificationRouteImport } from "./routes/verification";

const IndexRoute = IndexRouteImport.update({ id: "/", path: "/", getParentRoute: () => RootRoute });
const AuthRoute = AuthRouteImport.update({ id: "/auth", path: "/auth", getParentRoute: () => RootRoute });
const ConnectWalletRoute = ConnectWalletRouteImport.update({ id: "/connect-wallet", path: "/connect-wallet", getParentRoute: () => RootRoute });
const FollowerRoute = FollowerRouteImport.update({ id: "/follower", path: "/follower", getParentRoute: () => RootRoute });
const MarketplaceRoute = MarketplaceRouteImport.update({ id: "/marketplace", path: "/marketplace", getParentRoute: () => RootRoute });
const MarketplaceSlugRoute = MarketplaceSlugRouteImport.update({ id: "/marketplace/$slug", path: "/marketplace/$slug", getParentRoute: () => RootRoute });
const PrivacyRoute = PrivacyRouteImport.update({ id: "/privacy", path: "/privacy", getParentRoute: () => RootRoute });
const RiskDisclosureRoute = RiskDisclosureRouteImport.update({ id: "/risk-disclosure", path: "/risk-disclosure", getParentRoute: () => RootRoute });
const StudioRoute = StudioRouteImport.update({ id: "/studio", path: "/studio", getParentRoute: () => RootRoute });
const SubscriptionsRoute = SubscriptionsRouteImport.update({ id: "/subscriptions", path: "/subscriptions", getParentRoute: () => RootRoute });
const TermsRoute = TermsRouteImport.update({ id: "/terms", path: "/terms", getParentRoute: () => RootRoute });
const VerificationRoute = VerificationRouteImport.update({ id: "/verification", path: "/verification", getParentRoute: () => RootRoute });

const routeTree = RootRoute.addChildren([
  IndexRoute, AuthRoute, ConnectWalletRoute, FollowerRoute, MarketplaceRoute,
  MarketplaceSlugRoute, PrivacyRoute, RiskDisclosureRoute, StudioRoute,
  SubscriptionsRoute, TermsRoute, VerificationRoute,
]);

export { routeTree };
