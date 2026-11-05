import { auth, defineMcp } from "@lovable.dev/mcp-js";
import getBotStatus from "./tools/get-bot-status";
import listExchangeConnections from "./tools/list-exchange-connections";
import listTrades from "./tools/list-trades";
import listPositions from "./tools/list-positions";
import { PUBLIC_SUPABASE_PROJECT_ID } from "@/lib/public-env";

const projectRef = PUBLIC_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "turtle-bot-mcp",
  title: "Turtle Bot",
  version: "0.1.0",
  instructions:
    "Read-only tools for the Turtle trading bot. Inspect bot status, connected exchanges, trades, and positions for the signed-in user. This bot only reads/trades via user-provided exchange API keys — it can never move user funds.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [getBotStatus, listExchangeConnections, listTrades, listPositions],
});
