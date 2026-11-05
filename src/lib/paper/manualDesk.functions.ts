import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { paperDeskTicket } from "./manualDesk";

export const submitPaperDeskOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => paperDeskTicket.parse(input))
  .handler(async ({ data, context }) => {
    const { executePaperDeskOrder } = await import("./manualDesk.server");
    return executePaperDeskOrder(context, data);
  });
