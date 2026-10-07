import { readFileSync } from "node:fs";
import { request } from "node:https";

export interface KubernetesClientPort {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}
export class KubernetesApiError extends Error {
  constructor(readonly statusCode: number) {
    super(`Kubernetes API request failed (${statusCode}).`);
  }
}
/** In-cluster HTTPS client. Reads the projected token again for every request. */
export class KubernetesClient implements KubernetesClientPort {
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/apis/") && !path.startsWith("/api/"))
      throw new Error("Invalid Kubernetes API path.");
    const directory = "/var/run/secrets/kubernetes.io/serviceaccount";
    const token = readFileSync(`${directory}/token`, "utf8").trim();
    const ca = readFileSync(`${directory}/ca.crt`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname:
            process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc",
          port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443"),
          path,
          method,
          ca,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(payload === undefined
              ? {}
              : {
                  "Content-Type":
                    method === "PATCH"
                      ? "application/merge-patch+json"
                      : "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) {
              req.destroy(
                new Error("Kubernetes response exceeded the size limit."),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const code = response.statusCode ?? 500;
            if (code < 200 || code >= 300) {
              reject(new KubernetesApiError(code));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
            } catch {
              reject(new Error("Invalid Kubernetes JSON response."));
            }
          });
        },
      );
      req.setTimeout(30_000, () =>
        req.destroy(new Error("Kubernetes request timed out.")),
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
export const kubernetesNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
