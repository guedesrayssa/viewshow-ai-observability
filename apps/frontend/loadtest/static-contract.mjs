/** Content checks shared by the preflight and every completed load-test response. */
import { createHash } from "node:crypto";

const mediaTypes = {
  ".js": ["application/javascript", "text/javascript", "application/x-javascript"],
  ".css": ["text/css"],
  ".woff": ["font/woff", "application/font-woff"],
  ".woff2": ["font/woff2", "application/font-woff2"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".svg": ["image/svg+xml"],
};

/** Autocannon preserves HTTP header casing, unlike the Fetch Headers interface. */
export function contentTypeHeader(headers) {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
}

/** Returns a failure reason or null; an HTML fallback is never a valid static asset. */
export function contentFailure(requestPath, status, contentType, body) {
  if (status !== 200) return `HTTP ${status}`;
  if (!body || body.length === 0) return "empty response";
  const pathname = new URL(requestPath, "http://local.invalid").pathname;
  const type = (typeof contentType === "string" ? contentType : "").split(";")[0].trim().toLowerCase();
  const html = /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body.toString().slice(0, 512));
  if (pathname.endsWith("/")) return type === "text/html" && html ? null : "page is not HTML";
  if (html) return "HTML fallback returned for a static asset";
  const extension = pathname.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase();
  const allowed = mediaTypes[extension];
  if (!allowed) return `unverified static extension ${extension || "unknown"}`;
  return allowed.includes(type) ? null : `unexpected Content-Type ${type || "missing"}`;
}

/** Identifies downloaded bytes without storing the actual page or asset content. */
export function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}
