import { z } from "zod";

import { createOpenCodeGoProvider } from "../modules/ai-insights/opencode-go-provider.ts";

const environmentSchema = z.object({
  OPENCODE_GO_API_KEY: z.string().regex(/^[\x21-\x7e]+$/),
  OPENCODE_GO_MODEL: z
    .string()
    .regex(/^[A-Za-z0-9_./:-]{1,128}$/)
    .optional(),
});

// Operator-run provider probe. It prints no secret and no model output.
async function main(): Promise<void> {
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    console.log(JSON.stringify({ failureCategory: "MISSING_CONFIGURATION" }));
    process.exitCode = 1;
    return;
  }
  const provider = createOpenCodeGoProvider({
    apiKey: parsed.data.OPENCODE_GO_API_KEY,
    model: parsed.data.OPENCODE_GO_MODEL,
  });
  const result = await provider.generate({ text: "Reply with the word OK." });
  const last = result.attempts.at(-1);
  console.log(
    JSON.stringify({
      httpStatus: last?.httpStatus ?? null,
      failureCategory: result.ok
        ? null
        : (last?.failureCategory ?? result.failureCategory),
      responseTextLength: result.ok ? result.text.length : 0,
    }),
  );
}

void main().catch(() => {
  console.log(JSON.stringify({ failureCategory: "SMOKE_FAILED" }));
  process.exitCode = 1;
});
