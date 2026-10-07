const OLLAMA_URL_ERROR =
  "VIEW_SHOW_OLLAMA_BASE_URL must be an RFC1918 HTTP(S) endpoint without credentials or path";

function isRfc1918(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return false;
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

export function normalizePrivateOllamaBaseUrl(raw) {
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(OLLAMA_URL_ERROR);
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !isRfc1918(endpoint.hostname) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new Error(OLLAMA_URL_ERROR);
  }
  return `${endpoint.protocol}//${endpoint.host}`;
}
