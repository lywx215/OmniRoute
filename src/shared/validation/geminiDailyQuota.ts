import { z } from "zod";

const geminiDailyQuotaSchema = z
  .object({
    enabled: z.boolean().optional(),
    flashRpd: z.number().int().min(1).max(10_000_000).optional(),
    flashLiteRpd: z.number().int().min(1).max(10_000_000).optional(),
    disableMinuteLimits: z.boolean().optional(),
  })
  .strict();

export function validateGeminiDailyQuota(value: unknown, ctx: z.RefinementCtx): void {
  if (value === undefined || value === null) return;
  const result = geminiDailyQuotaSchema.safeParse(value);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `providerSpecificData.geminiDailyQuota: ${issue.message}`,
      path: ["geminiDailyQuota", ...issue.path],
    });
  }
}
