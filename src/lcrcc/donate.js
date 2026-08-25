import { createCheckoutSession, verifyStripeWebhook, getChargeFee } from "./stripe.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function handleCreateCheckoutSession(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const firstName = typeof body?.firstName === "string" ? body.firstName.trim().slice(0, 200) : "";
  const lastName = typeof body?.lastName === "string" ? body.lastName.trim().slice(0, 200) : "";
  const email = typeof body?.email === "string" ? body.email.trim().slice(0, 200) : "";
  const address = typeof body?.address === "string" ? body.address.trim().slice(0, 300) : "";
  const employerOccupation = typeof body?.employerOccupation === "string" ? body.employerOccupation.trim().slice(0, 200) : "";
  const amount = Number(body?.amount);
  const attestationSigned = body?.attestationSigned === true;

  if (!firstName || !lastName || !address || !email || !EMAIL_PATTERN.test(email)) {
    return json({ error: "name, a valid email, and address are required" }, 400);
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 25000) {
    return json({ error: "enter a valid donation amount" }, 400);
  }
  if (!attestationSigned) {
    return json({ error: "the foreign national attestation is required before we can accept a contribution" }, 400);
  }

  try {
    const session = await createCheckoutSession(env, url.origin, {
      amount,
      firstName,
      lastName,
      email,
      address,
      employerOccupation,
    });
    return json({ url: session.url });
  } catch (err) {
    return json({ error: "could not start checkout - please try again shortly" }, 502);
  }
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("Stripe-Signature");

  if (!(await verifyStripeWebhook(rawBody, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: "invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid payload" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta = session.metadata || {};
    const amount = (session.amount_total || 0) / 100;

    let feeAmount = null;
    try {
      feeAmount = await getChargeFee(env, session.payment_intent);
    } catch (err) {
      // Non-fatal - the contribution still gets recorded; the fee can be
      // filled in later from the Stripe dashboard if this lookup fails.
      console.error("getChargeFee failed:", session.payment_intent, err.message);
    }

    const now = new Date().toISOString();
    await env.LCRCC_DB.prepare(
      `INSERT INTO contributions (first_name, last_name, address, employer_occupation, amount, fee_amount, fee_paid_by, contribution_date, payment_method, attestation_signed, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        meta.first_name || "",
        meta.last_name || "",
        meta.address || "",
        meta.employer_occupation || "",
        amount,
        feeAmount,
        feeAmount !== null ? "committee" : null,
        now.slice(0, 10),
        "Card",
        meta.attestation_signed === "true" ? 1 : 0,
        `Stripe checkout session ${session.id}`,
        now,
        now
      )
      .run();
  }

  return json({ received: true });
}

export async function handleDonateApi(request, env, url) {
  if (url.pathname === "/api/lcrcc/donate/create-checkout-session" && request.method === "POST") {
    return handleCreateCheckoutSession(request, env, url);
  }
  if (url.pathname === "/api/lcrcc/stripe-webhook" && request.method === "POST") {
    return handleStripeWebhook(request, env);
  }
  return json({ error: "not found" }, 404);
}

export function isLcrccDonateApiPath(pathname) {
  return pathname === "/api/lcrcc/donate/create-checkout-session" || pathname === "/api/lcrcc/stripe-webhook";
}
