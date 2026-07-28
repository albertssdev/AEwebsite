import { classify } from "./hive/classifier.js";
import { route } from "./hive/router.js";
import { logRoute, readRecentLogs } from "./hive/history.js";
import { PROVIDER_NAMES } from "./hive/adapters.js";

const GATE_COOKIE = "site_gate";
const GATE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function isGatedPath(pathname) {
  return pathname === "/hive.html" || pathname.startsWith("/LCRCC/");
}

function isHiveApiPath(pathname) {
  return pathname === "/api/hive/query" || pathname === "/api/hive/history";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function hmac(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeGateToken(signingKey) {
  const expiry = Math.floor(Date.now() / 1000) + GATE_MAX_AGE_SECONDS;
  const sig = await hmac(signingKey, String(expiry));
  return `${expiry}.${sig}`;
}

async function verifyGateToken(token, signingKey) {
  if (!token) return false;
  const [expiryStr, sig] = token.split(".");
  if (!expiryStr || !sig) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;
  const expectedSig = await hmac(signingKey, expiryStr);
  return sig === expectedSig;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function checkGate(request, env) {
  const token = getCookie(request, GATE_COOKIE);
  return verifyGateToken(token, env.GATE_SIGNING_KEY);
}

function safeNextPath(next) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

const ELECTRICAL_KEYWORDS = [
  "electric", "electrical", "electrician", "panel", "wiring", "wire",
  "outlet", "breaker", "circuit", "rewir", "lighting", "light fixture",
];
const PLUMBING_KEYWORDS = [
  "plumb", "drain", "sink", "faucet", "sewer", "sewage", "pipe",
  "water heater", "toilet", "shower", "leak", "clog",
];

function mentionsAny(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function dropOnePlumbingOnlyReview(reviews) {
  const index = reviews.findIndex(
    (r) => mentionsAny(r.text, PLUMBING_KEYWORDS) && !mentionsAny(r.text, ELECTRICAL_KEYWORDS)
  );
  if (index === -1) return reviews;
  return reviews.slice(0, index).concat(reviews.slice(index + 1));
}

function dedupeConsecutiveFirstNames(reviews) {
  const result = [];
  let lastFirstName = null;
  for (const review of reviews) {
    const firstName = review.author.trim().split(/\s+/)[0]?.toLowerCase() || null;
    if (firstName && firstName === lastFirstName) continue;
    result.push(review);
    lastFirstName = firstName;
  }
  return result;
}

async function fetchGoogleReviews(env) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${env.GOOGLE_PLACE_ID}`, {
    headers: {
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "reviews,rating,userRatingCount",
    },
  });
  if (!res.ok) {
    throw new Error(`Places API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const reviews = (data.reviews || []).map((r) => ({
    author: r.authorAttribution?.displayName || "Anonymous",
    rating: r.rating ?? null,
    text: r.text?.text || r.originalText?.text || "",
    relativeTime: r.relativePublishTimeDescription || "",
    publishTime: r.publishTime || "",
  }));
  const filtered = dropOnePlumbingOnlyReview(reviews);
  return {
    rating: data.rating ?? null,
    userRatingCount: data.userRatingCount ?? null,
    reviews: dedupeConsecutiveFirstNames(filtered),
    fetchedAt: new Date().toISOString(),
  };
}

export default {
  async scheduled(event, env, ctx) {
    const data = await fetchGoogleReviews(env);
    await env.REVIEWS_KV.put("reviews", JSON.stringify(data));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === "www.albertselectric.net") {
      url.hostname = "albertselectric.net";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/gate-auth" && request.method === "POST") {
      const form = await request.formData();
      const password = form.get("password") || "";
      const next = safeNextPath(form.get("next"));

      if (password === env.GATE_PASSWORD) {
        const token = await makeGateToken(env.GATE_SIGNING_KEY);
        const headers = new Headers();
        headers.set("Location", next);
        headers.append(
          "Set-Cookie",
          `${GATE_COOKIE}=${token}; Path=/; Max-Age=${GATE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`
        );
        return new Response(null, { status: 302, headers });
      }

      const retryUrl = new URL("/gate.html", url);
      retryUrl.searchParams.set("next", next);
      retryUrl.searchParams.set("error", "1");
      return Response.redirect(retryUrl.toString(), 302);
    }

    if (isGatedPath(url.pathname)) {
      const valid = await checkGate(request, env);
      if (!valid) {
        const gateUrl = new URL("/gate.html", url);
        gateUrl.searchParams.set("next", url.pathname + url.search);
        return Response.redirect(gateUrl.toString(), 302);
      }
    }

    if (isHiveApiPath(url.pathname)) {
      // The gate above protects the /hive.html page itself; this protects the API
      // routes directly, so the password can't be bypassed by hitting them straight —
      // that would otherwise let anyone run up the paid AI API bills behind them.
      const valid = await checkGate(request, env);
      if (!valid) {
        return json({ error: "unauthorized" }, 401);
      }

      if (url.pathname === "/api/hive/query" && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }

        const message = typeof body?.message === "string" ? body.message.trim() : "";
        const forceModel = typeof body?.model === "string" ? body.model : undefined;

        if (!message) {
          return json({ error: "message is required" }, 400);
        }
        if (forceModel && !PROVIDER_NAMES.includes(forceModel)) {
          return json({ error: `unknown provider "${forceModel}"` }, 400);
        }

        try {
          const result = await route(env, message, forceModel);
          await logRoute(env, message, result);
          return json({
            taskType: result.taskType,
            reason: result.reason,
            attempts: result.attempts,
            failed: result.failed,
            provider: result.result?.provider ?? null,
            model: result.result?.model ?? null,
            content: result.result?.content ?? null,
            isImage: result.taskType === "image" && !result.failed,
            error: null,
          });
        } catch (err) {
          // Not a technical failure — the provider rejected the request outright.
          // Surface it as an error rather than silently trying another provider.
          const { taskType, reason } = classify(message);
          return json({
            taskType,
            reason,
            attempts: [],
            failed: true,
            provider: null,
            model: null,
            content: null,
            isImage: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (url.pathname === "/api/hive/history" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 20;
        return json(await readRecentLogs(env, limit));
      }

      return json({ error: "not found" }, 404);
    }

    if (url.pathname === "/api/reviews" && request.method === "GET") {
      let cached = await env.REVIEWS_KV.get("reviews");
      if (!cached) {
        try {
          const data = await fetchGoogleReviews(env);
          cached = JSON.stringify(data);
          await env.REVIEWS_KV.put("reviews", cached);
        } catch (err) {
          console.error("fetchGoogleReviews failed:", err.message);
          return new Response(JSON.stringify({ error: "unavailable" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response(cached, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
