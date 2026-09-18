import { z } from "zod";

export type ArgusLiveSyncState = Readonly<{ enabled: boolean }>;

const argusLiveSyncItemSchema = z
  .object({
    pk: z.literal("CONTROL#ARGUS"),
    sk: z.literal("LIVE_SYNC"),
    enabled: z.boolean(),
  })
  .strict();

export class ArgusLiveSyncContractError extends Error {
  constructor() {
    super("ARGUS live sync configuration is invalid");
    this.name = "ArgusLiveSyncContractError";
  }
}

export function decodeArgusLiveSyncItem(item: unknown): boolean {
  const parsed = argusLiveSyncItemSchema.safeParse(item);
  if (!parsed.success) throw new ArgusLiveSyncContractError();
  return parsed.data.enabled;
}
