import type { FastifyInstance } from "fastify";
import { z } from "zod";

const ReconcileSchema = z.object({ connection_id: z.string().uuid() }).strict();
const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const integer=z.string().regex(/^-?\d{1,78}$/);
const position=z.object({instrument_address:address,signed_size:integer,balance:integer,entry_notional:integer,
  mark:integer,close_notional:integer.nullable(),close_fee:integer.nullable()});
const SnapshotSchema=z.object({chain_id:z.literal(8453),safe_address:address,module_address:address,owner_address:address,
  operator_address:address,session_valid_until:z.number().int(),slippage_bps:z.number().int(),margin_budget:integer,margin_spent:integer,
  reserve:integer,module_revision:integer,module_nonce:integer,module_enabled:z.boolean(),operator_exit_available:z.boolean(),
  live_entry_allowed:z.boolean(),positions:z.object({"BTC-USDC":position,"ETH-USDC":position}),
  observed_block:integer,block_hash:z.string().regex(/^0x[0-9a-f]{64}$/),timestamp:z.number().int()});
const RecoveryRequest=ReconcileSchema.extend({symbol:z.enum(["BTC-USDC","ETH-USDC"]),slippage_bps:z.number().int().min(1).max(1000)}).strict();
const ReceiptRequest=ReconcileSchema.extend({symbol:z.enum(["BTC-USDC","ETH-USDC"]),phase:z.enum(["enable_module","authorize_owner_exit","close_position"]),tx_hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),calldata_hash:z.string().regex(/^0x[0-9a-f]{64}$/)}).strict();
const ReceiptSchema=z.object({status:z.enum(["unknown","mined","confirmed","reverted"]),phase:z.enum(["enable_module","authorize_owner_exit","close_position"]),reconciliation_required:z.boolean()});
const RecoverySchema=z.object({phase:z.enum(["enable_module","authorize_owner_exit","close_position"]),
  symbol:z.enum(["BTC-USDC","ETH-USDC"]),signed_position_size:integer,observed_block:integer,expires_at:z.number().int(),
  owner_confirmation_required:z.literal(true),call:z.object({chain_id:z.literal(8453),from:address,to:address,value:z.literal("0x0"),data:z.string().regex(/^0x[0-9a-f]+$/).max(6000)})});

export function registerSynFuturesLifecycleRoutes(app: FastifyInstance, deps: {
  verifyBearer: (authorization: string | undefined) => Promise<{ sub: string }>;
  ownedConnection: (authorization: string, userId: string, connectionId: string) => Promise<{
    user_id: string; exchange: string; environment: string | null;
  } | null>;
  callSigner: (path: string, payload: Record<string, unknown>) => Promise<{
    ok: boolean; status: number; json: Record<string, unknown>;
  }>;
}) {
  for (const kind of ["positions","owner-recovery","owner-recovery-status"] as const) {
    app.post(`/v1/synfutures/${kind}`,async(req,reply)=>{
      const identity=await deps.verifyBearer(req.headers.authorization);
      const parsed=(kind==="positions"?ReconcileSchema:kind==="owner-recovery"?RecoveryRequest:ReceiptRequest).safeParse(req.body);
      if (!parsed.success)return reply.status(400).send({error:"INVALID_SYNFUTURES_REQUEST"});
      const id=parsed.data.connection_id;
      const connection=await deps.ownedConnection(req.headers.authorization!,identity.sub,id);
      if (!connection || connection.user_id!==identity.sub)return reply.status(404).send({error:"CONNECTION_NOT_FOUND"});
      if (connection.exchange!=="synfutures" || !["mainnet","production"].includes(connection.environment??""))
        return reply.status(409).send({error:"SYNFUTURES_CONNECTION_MISMATCH"});
      try {
        const extra=kind==="positions"?{}:kind==="owner-recovery"?RecoveryRequest.parse(req.body):ReceiptRequest.parse(req.body);
        const {connection_id:_id,...fields}=extra as Record<string,unknown>;
        const result=await deps.callSigner(`/v1/synfutures/${kind}`,{user_id:identity.sub,exchange_connection_id:id,
          ...fields});
        if (!result.ok)return reply.status(503).send({error:"SYNFUTURES_READ_UNCONFIRMED"});
        if (kind==="owner-recovery-status") {
          const dto=ReceiptSchema.safeParse(result.json);
          return dto.success?reply.send(dto.data):reply.status(503).send({error:"SYNFUTURES_READ_UNCONFIRMED"});
        }
        const dto=kind==="positions"?SnapshotSchema.safeParse(result.json.snapshot):RecoverySchema.safeParse(result.json.recovery);
        if (!dto.success)return reply.status(503).send({error:"SYNFUTURES_READ_UNCONFIRMED"});
        return reply.send({status:kind==="positions"?"snapshot":"owner_review_required",[kind==="positions"?"snapshot":"recovery"]:dto.data});
      } catch {return reply.status(503).send({error:"SYNFUTURES_READ_UNCONFIRMED"});}
    });
  }
  app.post("/v1/synfutures/reconcile-orders", async (req, reply) => {
    const identity = await deps.verifyBearer(req.headers.authorization);
    const parsed = ReconcileSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_SYNFUTURES_RECONCILIATION_REQUEST" });
    const id = parsed.data.connection_id;
    const connection = await deps.ownedConnection(req.headers.authorization!, identity.sub, id);
    if (!connection || connection.user_id !== identity.sub) return reply.status(404).send({ error: "CONNECTION_NOT_FOUND" });
    if (connection.exchange !== "synfutures" || !["mainnet", "production"].includes(connection.environment ?? "")) {
      return reply.status(409).send({ error: "SYNFUTURES_CONNECTION_MISMATCH" });
    }
    // Read-only chain recovery is available even when entries are paused.
    // No browser-supplied hash, address, signer key, user ID or RPC URL.
    try {
      const result = await deps.callSigner("/v1/synfutures/reconcile-orders", {
        user_id: identity.sub, exchange_connection_id: id,
      });
      if (!result.ok || result.json.status !== "reconciled" || typeof result.json.reconciliation_required !== "boolean") {
        return reply.status(503).send({ error: "SYNFUTURES_RECONCILIATION_UNCONFIRMED" });
      }
      return reply.send({ status: "reconciled", exchange: "synfutures", connection_id: id,
        reconciliation_required: result.json.reconciliation_required, correlation_id: req.id });
    } catch {
      return reply.status(503).send({ error: "SYNFUTURES_RECONCILIATION_UNCONFIRMED" });
    }
  });
}
