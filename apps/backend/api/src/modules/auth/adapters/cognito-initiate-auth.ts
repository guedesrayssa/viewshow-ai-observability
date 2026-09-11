import type { InitiateAuthFn } from "./cognito-password-authenticator.js";

// O SDK do Cognito é pesado e só é necessário em produção. Carregado sob
// demanda e uma vez só; este arquivo é o único que o referencia, para que os
// testes (que injetam um InitiateAuthFn falso) nunca o toquem.
let cachedSdk:
  | Promise<typeof import("@aws-sdk/client-cognito-identity-provider")>
  | null = null;

function loadSdk(): Promise<
  typeof import("@aws-sdk/client-cognito-identity-provider")
> {
  cachedSdk ??= import("@aws-sdk/client-cognito-identity-provider");
  return cachedSdk;
}

/** Implementação de produção do InitiateAuthFn: fala com o Cognito real. */
export const initiateAuthViaSdk: InitiateAuthFn = async (params) => {
  const { CognitoIdentityProviderClient, InitiateAuthCommand } =
    await loadSdk();
  const client = new CognitoIdentityProviderClient({ region: params.region });
  const response = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: params.clientId,
      AuthParameters: {
        USERNAME: params.username,
        PASSWORD: params.password,
        ...(params.secretHash ? { SECRET_HASH: params.secretHash } : {}),
      },
    }),
  );
  const result = response.AuthenticationResult;
  return {
    authenticationResult: result
      ? {
          idToken: result.IdToken,
          accessToken: result.AccessToken,
          refreshToken: result.RefreshToken,
          expiresIn: result.ExpiresIn,
          tokenType: result.TokenType,
        }
      : null,
  };
};
