import { z } from "zod";

export const CAPITAL_OPERATIONS = [
  "READ_CAPITAL",
  "MOVE_FUNDING_TO_PERPS",
  "MOVE_PERPS_TO_FUNDING",
] as const;

export const CapitalRequestSchema = z
  .object({
    connection_id: z.string().uuid(),
    operation: z.enum(CAPITAL_OPERATIONS),
    amount: z
      .string()
      .regex(/^\d+(?:\.\d{1,8})?$/)
      .optional(),
    asset: z.literal("USDT").default("USDT"),
    idempotency_key: z.string().min(8).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.operation !== "READ_CAPITAL" && (!value.amount || Number(value.amount) <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Positive amount required",
        path: ["amount"],
      });
    }
  });

export type CapitalRequest = z.infer<typeof CapitalRequestSchema>;
