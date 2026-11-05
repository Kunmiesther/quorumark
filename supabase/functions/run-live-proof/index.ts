// run-live-proof — flag-gated stub.
//
// This function historically returned an unconditional 410 to guarantee no
// mainnet action. It is now gated by the owner-controlled APEX_MAINNET_*
// flags: when the owner has NOT enabled the compliance, signer, and canary
// gates, the previous 410/MAINNET_DISABLED
// behavior is preserved verbatim.
//
// When the owner HAS enabled those flags, this stub returns 501/NOT_IMPLEMENTED
// so callers see an honest "not wired here" response instead of a silent
// authority rejection — the live-execution path lives in the Railway broker
// and signer, not in this edge function.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function flag(name: string): boolean {
  return Deno.env.get(name) === "true";
}

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const mainnetEnabled =
    flag("APEX_MAINNET_COMPLIANCE_APPROVED") &&
    flag("APEX_MAINNET_SIGNER_ENABLED") &&
    flag("APEX_MAINNET_CANARY_ENABLED");
  if (!mainnetEnabled) {
    return new Response(
      JSON.stringify({
        error: "MAINNET_DISABLED",
        message:
          "Mainnet execution is unavailable pending jurisdiction and licensing approval.",
      }),
      { status: 410, headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      error: "NOT_IMPLEMENTED",
      message:
        "Live execution is not routed through this edge function. The Railway broker + signer handle mainnet orders.",
    }),
    { status: 501, headers: { ...corsHeaders, "content-type": "application/json" } },
  );
});
