import { describe, expect, it } from "vitest";
import {
  CognitoPasswordAuthenticator,
  type InitiateAuthFn,
} from "../src/modules/auth/adapters/cognito-password-authenticator.ts";
import { PasswordLoginUseCases } from "../src/modules/auth/application/password-login-use-cases.ts";
import type {
  PasswordAuthFailureReason,
  PasswordAuthOutcome,
  PasswordAuthenticatorPort,
} from "../src/modules/auth/ports/password-authenticator.ts";

function idToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `${header}.${body}.signature-nao-verificada`;
}

function throwsNamed(name: string): InitiateAuthFn {
  return async () => {
    throw Object.assign(new Error(name), { name });
  };
}

const config = {
  region: "us-east-1",
  clientId: "client-123",
  clientSecret: "segredo-do-client",
};

describe("CognitoPasswordAuthenticator (mock do InitiateAuth do Cognito)", () => {
  it("devolve identidade, papel a partir dos grupos e tokens num login válido", async () => {
    const calls: Parameters<InitiateAuthFn>[0][] = [];
    const initiateAuth: InitiateAuthFn = async (params) => {
      calls.push(params);
      return {
        authenticationResult: {
          idToken: idToken({
            sub: "user-1",
            email: "ana@globo.com",
            name: "Ana",
            "cognito:groups": ["engineer"],
          }),
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresIn: 28_800,
          tokenType: "Bearer",
        },
      };
    };

    const outcome = await new CognitoPasswordAuthenticator(
      config,
      initiateAuth,
    ).authenticate({ username: "ana@globo.com", password: "Senha-correta-1" });

    expect(outcome).toEqual({
      ok: true,
      identity: {
        id: "user-1",
        email: "ana@globo.com",
        name: "Ana",
        role: "engineer",
      },
      tokens: {
        idToken: expect.any(String),
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresInSeconds: 28_800,
        tokenType: "Bearer",
      },
    });
    // Client com secret: o SECRET_HASH é calculado e enviado.
    expect(calls).toHaveLength(1);
    expect(calls[0].secretHash).toEqual(expect.any(String));
    expect(calls[0].username).toBe("ana@globo.com");
  });

  it("omite o SECRET_HASH quando o client não tem secret", async () => {
    const calls: Parameters<InitiateAuthFn>[0][] = [];
    const authenticator = new CognitoPasswordAuthenticator(
      { ...config, clientSecret: null },
      async (params) => {
        calls.push(params);
        return {
          authenticationResult: {
            idToken: idToken({ sub: "u", email: "e@e.com" }),
            accessToken: "a",
          },
        };
      },
    );

    await authenticator.authenticate({ username: "e@e.com", password: "p" });

    expect(calls[0].secretHash).toBeNull();
  });

  it("cai para o papel viewer quando o token não traz grupo conhecido", async () => {
    const outcome = await new CognitoPasswordAuthenticator(
      config,
      async () => ({
        authenticationResult: {
          idToken: idToken({
            sub: "u",
            email: "e@e.com",
            "cognito:groups": ["algum-grupo"],
          }),
          accessToken: "a",
        },
      }),
    ).authenticate({ username: "e@e.com", password: "p" });

    expect(outcome).toMatchObject({ ok: true, identity: { role: "viewer" } });
  });

  it("mapeia NotAuthorizedException e UserNotFoundException para invalid_credentials", async () => {
    for (const name of ["NotAuthorizedException", "UserNotFoundException"]) {
      const outcome = await new CognitoPasswordAuthenticator(
        config,
        throwsNamed(name),
      ).authenticate({ username: "x@y.com", password: "errada" });
      expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
    }
  });

  it("mapeia UserNotConfirmedException para user_not_confirmed", async () => {
    const outcome = await new CognitoPasswordAuthenticator(
      config,
      throwsNamed("UserNotConfirmedException"),
    ).authenticate({ username: "x@y.com", password: "p" });
    expect(outcome).toEqual({ ok: false, reason: "user_not_confirmed" });
  });

  it("mapeia PasswordResetRequiredException para password_reset_required", async () => {
    const outcome = await new CognitoPasswordAuthenticator(
      config,
      throwsNamed("PasswordResetRequiredException"),
    ).authenticate({ username: "x@y.com", password: "p" });
    expect(outcome).toEqual({ ok: false, reason: "password_reset_required" });
  });

  it("mapeia throttling para rate_limited e erro desconhecido para unavailable", async () => {
    const throttled = await new CognitoPasswordAuthenticator(
      config,
      throwsNamed("TooManyRequestsException"),
    ).authenticate({ username: "x@y.com", password: "p" });
    expect(throttled).toEqual({ ok: false, reason: "rate_limited" });

    const broken = await new CognitoPasswordAuthenticator(config, async () => {
      throw new Error("ECONNRESET");
    }).authenticate({ username: "x@y.com", password: "p" });
    expect(broken).toEqual({ ok: false, reason: "unavailable" });
  });

  it("trata resposta de desafio (sem AuthenticationResult) como challenge_required", async () => {
    const outcome = await new CognitoPasswordAuthenticator(
      config,
      async () => ({
        authenticationResult: null,
      }),
    ).authenticate({ username: "x@y.com", password: "p" });
    expect(outcome).toEqual({ ok: false, reason: "challenge_required" });
  });

  it("trata ID token ilegível como unavailable", async () => {
    const outcome = await new CognitoPasswordAuthenticator(
      config,
      async () => ({
        authenticationResult: { idToken: "nao.e-um.jwt", accessToken: "a" },
      }),
    ).authenticate({ username: "x@y.com", password: "p" });
    expect(outcome).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("PasswordLoginUseCases (tradução de falha em HTTP)", () => {
  function useCasesWith(outcome: PasswordAuthOutcome): PasswordLoginUseCases {
    const port: PasswordAuthenticatorPort = {
      authenticate: async () => outcome,
    };
    return new PasswordLoginUseCases(port);
  }

  it("devolve identidade e tokens quando a autenticação passa", async () => {
    const identity = {
      id: "u",
      email: "e@e.com",
      name: null,
      role: "viewer",
    } as const;
    const tokens = {
      idToken: "id",
      accessToken: "ac",
      refreshToken: null,
      expiresInSeconds: 3_600,
      tokenType: "Bearer",
    };

    const result = await useCasesWith({ ok: true, identity, tokens }).login(
      "e@e.com",
      "p",
    );

    expect(result).toEqual({ identity, tokens });
  });

  const cases: readonly [PasswordAuthFailureReason, number, string][] = [
    ["invalid_credentials", 401, "UNAUTHENTICATED"],
    ["user_not_confirmed", 403, "FORBIDDEN"],
    ["password_reset_required", 403, "FORBIDDEN"],
    ["challenge_required", 403, "FORBIDDEN"],
    ["rate_limited", 429, "RATE_LIMITED"],
    ["unavailable", 503, "FEATURE_UNAVAILABLE"],
  ];

  it.each(cases)("mapeia %s para HTTP %i", async (reason, status, code) => {
    await expect(
      useCasesWith({ ok: false, reason }).login("e@e.com", "p"),
    ).rejects.toMatchObject({ status, code });
  });
});
