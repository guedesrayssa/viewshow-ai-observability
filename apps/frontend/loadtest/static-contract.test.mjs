import test from "node:test";
import assert from "node:assert/strict";
import { contentFailure, contentTypeHeader } from "./static-contract.mjs";

test("HTML fallbacks fail even with HTTP 200 and a forged JavaScript MIME", () => {
  const html = "<!DOCTYPE html><html><body>login</body></html>";
  assert.ok(contentFailure("/_next/static/chunk.js", 200, "text/html", html));
  assert.ok(contentFailure("/_next/static/chunk.js", 200, "text/javascript", html));
});
test("empty content, wrong media types and non-200 responses fail", () => {
  assert.ok(contentFailure("/_next/static/chunk.js", 200, "application/javascript", ""));
  assert.ok(contentFailure("/_next/static/styles.css", 200, "text/plain", "body {}"));
  assert.ok(contentFailure("/login/", 404, "text/html", "<html></html>"));
});
test("valid exported HTML, JavaScript, CSS and font content pass", () => {
  assert.equal(contentFailure("/login/", 200, "text/html; charset=utf-8", "<!DOCTYPE html><html></html>"), null);
  assert.equal(contentFailure("/_next/static/chunk.js?v=1", 200, "application/javascript", "console.log(1);"), null);
  assert.equal(contentFailure("/_next/static/styles.css", 200, "text/css", "body {}"), null);
  assert.equal(contentFailure("/_next/static/a.woff2", 200, "font/woff2", "wOF2..."), null);
});

test("HTTP header casing does not reject correctly served assets", () => {
  assert.equal(contentTypeHeader({ "Content-Type": "text/css" }), "text/css");
  assert.equal(contentTypeHeader({ "content-type": "text/css" }), "text/css");
});
