// All API paths are rewritten to this single Vercel Function. PostgreSQL keeps
// sessions and app data durable across cold starts and independent instances.
import { handleRequest } from "../server/index.js";

export default function handler(request, response) {
  const url = new URL(request.url, "http://localhost");
  // Depending on the Vercel runtime version, the rewrite may expose the destination path.
  // Reconstruct the public API path from the named splat when that happens.
  if (url.pathname.includes("[...]")) {
    const value = request.query?.path;
    const requestedPath = Array.isArray(value) ? value.join("/") : String(value || "");
    url.pathname = `/api/${requestedPath}`;
    url.searchParams.delete("path");
    request.url = `${url.pathname}${url.search}`;
  }
  return handleRequest(request, response);
}
