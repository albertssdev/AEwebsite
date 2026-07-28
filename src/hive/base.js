export class ProviderHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Fetch with a timeout, and throw ProviderHttpError on any non-2xx response. */
export async function fetchJson(url, options) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new ProviderHttpError(408, `request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderHttpError(res.status, `${res.status} ${body.slice(0, 400)}`);
  }

  return res.json();
}

/**
 * A "technical failure" is what the fallback chain reacts to: outages, rate limits,
 * timeouts, auth/config problems. A normal 200 response — even a refusal — is not
 * a technical failure and must be surfaced as-is, never silently retried elsewhere.
 */
export function isTechnicalFailure(err) {
  const technicalStatusCodes = new Set([401, 403, 404, 408, 409, 410, 429, 500, 502, 503, 504]);
  if (typeof err?.status === "number" && technicalStatusCodes.has(err.status)) return true;
  if (typeof err?.message === "string" && /timeout/i.test(err.message)) return true;
  return false;
}

/** Turns a raw error into a short, actionable hint for the routing log. */
export function describeError(err) {
  const message = err?.message ?? String(err);
  switch (err?.status) {
    case 401:
    case 403:
      return `auth failed — check the API key (${message})`;
    case 404:
      return `model not found — likely deprecated or renamed (${message})`;
    case 410:
      return `endpoint/feature retired — check provider docs (${message})`;
    case 429:
      return `rate limited or quota exceeded (${message})`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `provider-side error — likely transient (${message})`;
    default:
      return message;
  }
}
