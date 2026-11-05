// run-testnet-proof — DEPRECATED / DISABLED.
//
// Testnet has been removed from the customer experience. This function is
// intentionally fail-closed and returns HTTP 410 before touching auth,
// secrets, credentials, DB, or building any intent. It CANNOT fall
// through to any mainnet venue path.
//
// Do not restore the previous body. Do not import execution-broker,
// exchange adapters, proof-gate, or credentials from this file.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      error: "TESTNET_DISABLED",
      message: "Testnet is not used. This function is deprecated.",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "content-type": "application/json" },
    },
  );
});
