// TEMPORARY, ONE-TIME USE — imports the Aug 2026 committee roster into Brevo.
// Protected by a hardcoded token (not a stored secret; this route is meant to
// be deployed, called once, then deleted entirely in a follow-up commit).
// Do not leave this route in place longer than necessary.

const IMPORT_TOKEN = "d3eeb6eb46691d990b9519ac85e84a6655cb4661218c7760";
const BREVO_API = "https://api.brevo.com/v3";

async function addContact(env, { email, firstName, lastName, listIds }) {
  const res = await fetch(`${BREVO_API}/contacts`, {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      email,
      attributes: { FIRSTNAME: firstName || "", LASTNAME: lastName || "" },
      listIds,
      updateEnabled: true,
    }),
  });
  const ok = res.ok;
  const detail = ok ? null : await res.text().catch(() => "");
  return { email, ok, status: res.status, detail };
}

export async function handleTempBulkImport(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== IMPORT_TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const { contacts, listIds } = body;
  if (!Array.isArray(contacts) || !Array.isArray(listIds)) {
    return new Response(JSON.stringify({ error: "expected { contacts: [...], listIds: [...] }" }), { status: 400 });
  }

  const results = [];
  for (const c of contacts) {
    try {
      results.push(await addContact(env, { ...c, listIds }));
    } catch (err) {
      results.push({ email: c.email, ok: false, detail: err.message });
    }
  }

  return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
}

export function isTempBulkImportPath(pathname) {
  return pathname === "/api/lcrcc/temp-bulk-import";
}
