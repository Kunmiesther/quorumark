import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { discoveryRequestSchema } from "./discovery";

export const discoverPools = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(discoveryRequestSchema)
  .handler(async ({ data }) => {
    const { searchDiscovery } = await import("./discovery.server");
    return searchDiscovery(data);
  });
