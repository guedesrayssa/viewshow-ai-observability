import { z } from "zod";

/**
 * Corpo aceito por `POST /auth/login`: credencial direta de usuário e senha,
 * trocada por uma sessão sem passar pelo Hosted UI do provedor.
 */
export const passwordLoginBodySchema = z
  .object({
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(256),
  })
  .strict();

export type PasswordLoginBody = z.infer<typeof passwordLoginBodySchema>;
