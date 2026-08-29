const BREVO_API = "https://api.brevo.com/v3";

// Adds (or updates) a contact and puts them on the given lists. Brevo owns
// per-list subscribe/unsubscribe from here on - a contact can be pulled off
// the Newsletter list while staying on Announcements without any custom
// unsubscribe logic on our side.
export async function addContactToLists(env, { email, name, listIds }) {
  const [firstName, ...rest] = (name || "").trim().split(/\s+/);
  const lastName = rest.join(" ");

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

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Brevo API error (${res.status}): ${errBody}`);
  }
}
