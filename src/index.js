import { classify } from "./hive/classifier.js";
import { route } from "./hive/router.js";
import { makeTitle, listConversations, getConversation, saveConversation, deleteConversation } from "./hive/conversations.js";
import { PROVIDERS, PROVIDER_NAMES } from "./hive/adapters.js";
import { describeError } from "./hive/base.js";

const GATE_COOKIE = "site_gate";
const GATE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function isGatedPath(pathname) {
  // LCRCC gate temporarily disabled — re-add `|| pathname.startsWith("/LCRCC/")` to restore.
  return pathname === "/hive.html";
}

function isHiveApiPath(pathname) {
  return pathname.startsWith("/api/hive/");
}

const LCRCC_ALIAS_HOSTNAMES = new Set([
  "www.lcrccmissouri.org",
  "lcrccmissouri.com",
  "www.lcrccmissouri.com",
  "lcrccmissouri.net",
  "www.lcrccmissouri.net",
]);

// Applied to every page/asset/API response. HSTS max-age is intentionally
// set here rather than left to Cloudflare's dashboard-level HSTS toggle —
// no `preload` directive, since submitting to the browser preload list is
// hard to reverse and nobody's asked for that yet.
const SECURITY_HEADERS = {
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  // "same-site" (not "same-origin") so the related autocrunch.albertselectric.net
  // subdomain can still load this site's resources cross-origin if it ever needs to.
  "Cross-Origin-Resource-Policy": "same-site",
};

// Scoped to CSP_SCOPED_PATHS (the four business pages) rather than applied
// site-wide — see the comment on that constant for why.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://secure.copilotcrm.com https://static.cloudflareinsights.com",
  "style-src 'self' https://secure.copilotcrm.com",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://secure.copilotcrm.com https://cloudflareinsights.com",
  "frame-src https://secure.copilotcrm.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://secure.copilotcrm.com",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests",
].join("; ");

function withSecurityHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data, status = 200) {
  return withSecurityHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
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

// Redirect target after a successful gate-auth. Deliberately NOT a general
// open redirect: relative site paths are allowed, plus one specific
// whitelisted external destination (the gated Autocrunch link), never an
// arbitrary "next" value from the request.
const ALLOWED_EXTERNAL_NEXT = new Set(["https://autocrunch.albertselectric.net/"]);

function safeNextPath(next) {
  if (ALLOWED_EXTERNAL_NEXT.has(next)) return next;
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

// Reused for both visit tracking and CSP scoping — these are the four public
// business pages. The gate, hive, LCRCC, and sermon-search pages elsewhere on
// this domain rely on inline scripts and third-party CDNs (Tailwind, fuse.js,
// Facebook SDK) a strict CSP would break, and are already password-gated /
// noindex, so a site-wide policy isn't worth the trade-off.
const CSP_SCOPED_PATHS = new Set([
  "/", "/index.html",
  "/about", "/about.html",
  "/services", "/services.html",
  "/contact", "/contact.html",
]);

async function recordVisit(env, ctx) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `visits:${day}`;
  ctx.waitUntil(
    (async () => {
      const current = Number(await env.VISITS_KV.get(key)) || 0;
      const count = current + 1;
      // expirationTtl keeps exactly a rolling 365-day window without any
      // separate pruning logic — old day-keys just fall out of KV on their own.
      await env.VISITS_KV.put(key, String(count), {
        expirationTtl: 365 * 24 * 60 * 60,
        metadata: { count },
      });
    })()
  );
}

async function totalVisits(env) {
  let total = 0;
  let cursor;
  do {
    const page = await env.VISITS_KV.list({ prefix: "visits:", cursor });
    for (const key of page.keys) {
      total += key.metadata?.count ?? 0;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return total;
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

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.hostname === "www.albertselectric.net") {
      url.hostname = "albertselectric.net";
      // 308 (not 301/302) is required here: 301/302 redirects silently downgrade
      // a POST to a GET in virtually every browser, which would drop the gate
      // password entirely for anyone submitting the login form from "www.".
      // 308 preserves the method and body.
      return Response.redirect(url.toString(), 308);
    }

    // LCRCC has its own domain now. .com/.net and the www. variants all
    // consolidate onto the bare .org, and the old albertselectric.net/LCRCC/
    // path permanently redirects there too so existing links keep working.
    if (LCRCC_ALIAS_HOSTNAMES.has(url.hostname)) {
      url.hostname = "lcrccmissouri.org";
      return Response.redirect(url.toString(), 301);
    }

    if (url.hostname === "albertselectric.net" && url.pathname.startsWith("/LCRCC/")) {
      const target = new URL(url.pathname.slice("/LCRCC".length) || "/", "https://lcrccmissouri.org");
      target.search = url.search;
      return Response.redirect(target.toString(), 301);
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
          // Domain=.albertselectric.net (vs. host-only) so the gate cookie is
          // also sent to autocrunch.albertselectric.net, which independently
          // verifies it against the same GATE_SIGNING_KEY, see that
          // worker's src/index.js.
          `${GATE_COOKIE}=${token}; Domain=.albertselectric.net; Path=/; Max-Age=${GATE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`
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

      if (url.pathname === "/api/hive/conversations" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 50;
        return json(await listConversations(env, limit));
      }

      if (url.pathname === "/api/hive/doctor" && request.method === "GET") {
        const results = [];
        for (const name of PROVIDER_NAMES) {
          const provider = PROVIDERS[name];
          const model = provider.model(env);
          if (!provider.isConfigured(env)) {
            results.push({ provider: name, model, configured: false, ok: false, error: null, ms: null });
            continue;
          }
          const start = Date.now();
          try {
            await provider.generateText(env, [{ role: "user", content: "Reply with only the word: OK" }]);
            results.push({ provider: name, model, configured: true, ok: true, error: null, ms: Date.now() - start });
          } catch (err) {
            results.push({
              provider: name,
              model,
              configured: true,
              ok: false,
              error: describeError(err),
              ms: Date.now() - start,
            });
          }
        }
        return json(results);
      }

      const convMatch = url.pathname.match(/^\/api\/hive\/conversations\/([^/]+)(?:\/(messages))?$/);

      if (convMatch && !convMatch[2] && request.method === "GET") {
        const conv = await getConversation(env, convMatch[1]);
        if (!conv) return json({ error: "not found" }, 404);
        return json(conv);
      }

      if (convMatch && !convMatch[2] && request.method === "DELETE") {
        await deleteConversation(env, convMatch[1]);
        return json({ ok: true });
      }

      if (convMatch && !convMatch[2] && request.method === "PATCH") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        if (!title) return json({ error: "title is required" }, 400);

        const conv = await getConversation(env, convMatch[1]);
        if (!conv) return json({ error: "not found" }, 404);

        conv.title = makeTitle(title);
        conv.updatedAt = new Date().toISOString();
        await saveConversation(env, conv);
        return json({ ok: true, title: conv.title });
      }

      if (convMatch && convMatch[2] === "messages" && request.method === "POST") {
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

        const id = convMatch[1];
        const now = new Date().toISOString();
        let conv = id !== "new" ? await getConversation(env, id) : null;
        if (!conv) {
          conv = { id: crypto.randomUUID(), title: makeTitle(message), createdAt: now, updatedAt: now, messages: [] };
        }
        conv.messages.push({ role: "user", content: message, timestamp: now });

        // The last assistant turn's provider, used as a routing hint for contextless
        // follow-ups ("make it bigger") that carry no classifiable signal of their own.
        const lastAssistant = [...conv.messages].reverse().find((m) => m.role === "assistant" && m.provider);
        const stickyProvider = lastAssistant?.provider;
        const modelMessages = conv.messages.map((m) => ({ role: m.role, content: m.content }));

        let result;
        let routeError = null;
        try {
          result = await route(env, modelMessages, forceModel, stickyProvider);
        } catch (err) {
          // Not a technical failure — the provider rejected the request outright.
          // Surface it as an error rather than silently trying another provider.
          const { taskType, reason } = classify(message);
          result = { taskType, reason, attempts: [], failed: true };
          routeError = err instanceof Error ? err.message : String(err);
        }

        const assistantEntry = {
          role: "assistant",
          content: result.result?.content ?? null,
          thinking: result.result?.thinking ?? null,
          timestamp: new Date().toISOString(),
          taskType: result.taskType,
          reason: result.reason,
          attempts: result.attempts,
          provider: result.result?.provider ?? null,
          model: result.result?.model ?? null,
          isImage: result.taskType === "image" && !result.failed,
          failed: result.failed,
          error: routeError,
        };
        conv.messages.push(assistantEntry);
        conv.updatedAt = assistantEntry.timestamp;
        await saveConversation(env, conv);

        return json({
          conversationId: conv.id,
          title: conv.title,
          taskType: result.taskType,
          reason: result.reason,
          attempts: result.attempts,
          failed: result.failed,
          provider: assistantEntry.provider,
          model: assistantEntry.model,
          content: assistantEntry.content,
          thinking: assistantEntry.thinking,
          isImage: assistantEntry.isImage,
          error: routeError,
        });
      }

      return json({ error: "not found" }, 404);
    }

    if (url.pathname === "/.well-known/security.txt" || url.pathname === "/security.txt") {
      // Served directly rather than as a static asset — Workers' asset
      // serving has had inconsistent handling of dotfile paths like
      // /.well-known/, so this guarantees it resolves regardless.
      const body = [
        "Contact: mailto:albertselectricoffice@gmail.com",
        "Expires: 2027-08-14T00:00:00.000Z",
        "Preferred-Languages: en",
      ].join("\n") + "\n";
      return withSecurityHeaders(new Response(body, { headers: { "Content-Type": "text/plain" } }));
    }

    if (url.pathname === "/service-area" || url.pathname === "/service-area.html") {
      // Service Area page merged into About — redirect old links/bookmarks instead
      // of letting them 404.
      const aboutUrl = new URL("/about.html#service-area", url);
      return Response.redirect(aboutUrl.toString(), 301);
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
          return withSecurityHeaders(
            new Response(JSON.stringify({ error: "unavailable" }), {
              status: 502,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
      }
      return withSecurityHeaders(
        new Response(cached, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
          },
        })
      );
    }

    if (url.pathname === "/api/visits" && request.method === "GET") {
      const total = await totalVisits(env);
      return json({ total, days: 365 });
    }

    if (url.pathname === "/api/lcrcc/contact" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }

      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 200) : "";
      const email = typeof body?.email === "string" ? body.email.trim().slice(0, 200) : "";
      const subject = typeof body?.subject === "string" ? body.subject.trim().slice(0, 200) : "";
      const message = typeof body?.message === "string" ? body.message.trim().slice(0, 5000) : "";

      if (!name || !EMAIL_PATTERN.test(email) || !message) {
        return json({ error: "name, a valid email, and message are required" }, 400);
      }

      try {
        await env.EMAIL.send({
          to: "lcrccmo@gmail.com",
          from: { email: "contactform@lcrccmissouri.org", name: "LCRCC Missouri Website" },
          replyTo: email,
          subject: `LCRCC Contact Form: ${subject || "New message"}`,
          html: `
            <p><strong>Name:</strong> ${escapeHtml(name)}</p>
            <p><strong>Email:</strong> ${escapeHtml(email)}</p>
            ${subject ? `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>` : ""}
            <p><strong>Message:</strong></p>
            <p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>
          `,
          text: `Name: ${name}\nEmail: ${email}\n${subject ? `Subject: ${subject}\n` : ""}\nMessage:\n${message}`,
        });
        return json({ ok: true });
      } catch (err) {
        console.error("LCRCC contact email failed:", err.code, err.message);
        return json({ error: "failed to send" }, 502);
      }
    }

    if (url.pathname === "/api/lcrcc/subscribe" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }

      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 200) : "";
      const email = typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
      const county = typeof body?.county === "string" ? body.county.trim().slice(0, 100) : "";

      if (!name || !EMAIL_PATTERN.test(email)) {
        return json({ error: "name and a valid email are required" }, 400);
      }

      const subscribedAt = new Date().toISOString();
      await env.LCRCC_SIGNUPS_KV.put(
        `signup:${email}`,
        JSON.stringify({ name, email, county, subscribedAt })
      );

      try {
        await env.EMAIL.send({
          to: "lcrccmo@gmail.com",
          from: { email: "contactform@lcrccmissouri.org", name: "LCRCC Missouri Website" },
          replyTo: email,
          subject: "LCRCC Email List: New signup",
          html: `
            <p><strong>Name:</strong> ${escapeHtml(name)}</p>
            <p><strong>Email:</strong> ${escapeHtml(email)}</p>
            ${county ? `<p><strong>County:</strong> ${escapeHtml(county)}</p>` : ""}
          `,
          text: `Name: ${name}\nEmail: ${email}\n${county ? `County: ${county}\n` : ""}`,
        });
      } catch (err) {
        // The signup is already saved in KV regardless - the notification
        // email is a convenience, not the source of truth, so a failure
        // here shouldn't fail the signup itself.
        console.error("LCRCC signup notification email failed:", err.code, err.message);
      }

      return json({ ok: true });
    }

    // lcrccmissouri.org shares this Worker but is a distinct site - its "/"
    // must not be treated as albertselectric.net's homepage for visit
    // counting or CSP purposes (LCRCC relies on Tailwind CDN, Font Awesome,
    // and the Facebook SDK, which the business-page CSP would break).
    const isLcrccDomain = url.hostname === "lcrccmissouri.org";

    if (request.method === "GET" && !isLcrccDomain && CSP_SCOPED_PATHS.has(url.pathname)) {
      await recordVisit(env, ctx);
    }

    // lcrccmissouri.org has no assets of its own - it's served out of the
    // /LCRCC/ folder that also backs albertselectric.net/LCRCC/. "/" maps to
    // the clean (extensionless) form of lcrcc.html directly, since requesting
    // the .html path would otherwise 307 through the assets binding's own
    // clean-URL redirect - the Location it hands back is relative and unaware
    // of this rewrite, which would double-prefix the follow-up request.
    let assetRequest = request;
    if (isLcrccDomain) {
      const rewritten = new URL(request.url);
      rewritten.pathname = url.pathname === "/" ? "/LCRCC/lcrcc" : `/LCRCC${url.pathname}`;
      assetRequest = new Request(rewritten, request);
    }

    let assetResponse = await env.ASSETS.fetch(assetRequest);

    // Safety net for any other assets-binding redirect (e.g. someone linking
    // directly to a .html path): strip the /LCRCC prefix back off the
    // Location so the follow-up request resolves against lcrccmissouri.org
    // instead of getting double-prefixed by the rewrite above.
    if (isLcrccDomain && assetResponse.status >= 300 && assetResponse.status < 400) {
      const location = assetResponse.headers.get("Location");
      if (location && location.startsWith("/LCRCC/")) {
        const headers = new Headers(assetResponse.headers);
        headers.set("Location", location.slice("/LCRCC".length));
        assetResponse = new Response(assetResponse.body, { status: assetResponse.status, headers });
      }
    }

    const extra = !isLcrccDomain && CSP_SCOPED_PATHS.has(url.pathname)
      ? { "Content-Security-Policy": CONTENT_SECURITY_POLICY }
      : {};
    return withSecurityHeaders(assetResponse, extra);
  },
};
