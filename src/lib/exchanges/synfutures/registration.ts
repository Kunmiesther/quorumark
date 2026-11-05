import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-f]{40}$/);

/** Deployment identity is not permission to execute trades. */
export const synFuturesRegistration = z.object({
  id: z.string().uuid(),
  wallet_id: z.string().uuid(),
  setup_revision: z.number().int().positive(),
  chain_id: z.literal(8453),
  owner_address: address,
  safe_address: address,
  module_address: address,
  status: z.literal("deployed_operator_pending"),
  verified_at: z.string().datetime({ offset: true }),
  execution_ready: z.literal(false),
});

export type SynFuturesRegistration = z.infer<typeof synFuturesRegistration>;
