const GATE_COOKIE = "site_gate";
const GATE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function isGatedPath(pathname) {
  return pathname === "/hive.html" || pathname.startsWith("/LCRCC/");
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

function safeNextPath(next) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

export default {
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
      const token = getCookie(request, GATE_COOKIE);
      const valid = await verifyGateToken(token, env.GATE_SIGNING_KEY);
      if (!valid) {
        const gateUrl = new URL("/gate.html", url);
        gateUrl.searchParams.set("next", url.pathname + url.search);
        return Response.redirect(gateUrl.toString(), 302);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
