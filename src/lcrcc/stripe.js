// Talks to the Stripe REST API directly over fetch rather than the stripe-node
// SDK, since that SDK's default HTTP client doesn't work in the Workers
// runtime. Two things happen here: creating a Checkout Session when a donor
// submits the donation form, and verifying + handling the webhook Stripe
// calls back once that session completes.

const STRIPE_API = "https://api.stripe.com/v1";

function formEncode(obj, prefix = "") {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(formEncode(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object") parts.push(formEncode(item, `${fullKey}[${i}]`));
        else parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

async function stripeRequest(env, method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? formEncode(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe API error (${res.status})`);
  }
  return data;
}

export async function createCheckoutSession(env, origin, donor) {
  const { amount, firstName, lastName, email, address, employerOccupation } = donor;

  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "payment",
    customer_email: email,
    // lcrccmissouri.org serves the LCRCC page at "/" itself - "/LCRCC/lcrcc.html"
    // is not a real path on this domain (that's the asset's path inside the
    // repo, rewritten internally) and 404s if used directly.
    success_url: `${origin}/?donation=success`,
    cancel_url: `${origin}/?donation=cancelled`,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(amount * 100),
          product_data: { name: "Donation to LCRCC Missouri" },
        },
        quantity: 1,
      },
    ],
    metadata: {
      first_name: firstName,
      last_name: lastName,
      address,
      employer_occupation: employerOccupation || "",
      attestation_signed: "true",
    },
  });
}

async function hmacSha256Hex(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const WEBHOOK_TOLERANCE_SECONDS = 300;

// Implements Stripe's documented signature scheme by hand (no SDK): the
// header is "t=<unix ts>,v1=<hex hmac>", and the signed payload is
// "<ts>.<raw body>" - HMAC-SHA256 with the webhook secret. Rejecting stale
// timestamps guards against replaying an old, still-validly-signed payload.
export async function verifyStripeWebhook(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  const timestamp = Number(parts.t);
  const expectedSig = parts.v1;
  if (!Number.isFinite(timestamp) || !expectedSig) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const computedSig = await hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`);
  return computedSig === expectedSig;
}

export async function getChargeFee(env, paymentIntentId) {
  const pi = await stripeRequest(env, "GET", `/payment_intents/${paymentIntentId}?expand[]=latest_charge.balance_transaction`, null);
  const balanceTxn = pi?.latest_charge?.balance_transaction;
  return balanceTxn ? balanceTxn.fee / 100 : null;
}
