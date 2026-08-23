const SESSION_COOKIE = "lcrcc_admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 4; // 4 hours - shorter than the site gate, this guards donor PII
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_SECONDS = 60 * 15;

const SORT_COLUMNS = {
  name: "last_name, first_name",
  date: "contribution_date",
  amount: "amount",
  employer: "employer_occupation",
  method: "payment_method",
};

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

async function makeSessionToken(signingKey) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const sig = await hmac(signingKey, String(expiry));
  return `${expiry}.${sig}`;
}

async function verifySessionToken(token, signingKey) {
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function hasValidAdminSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  return verifySessionToken(token, env.LCRCC_ADMIN_SIGNING_KEY);
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function isLockedOut(env, ip) {
  const raw = await env.LCRCC_SIGNUPS_KV.get(`admin_lockout:${ip}`);
  if (!raw) return false;
  const count = Number(raw) || 0;
  return count >= LOCKOUT_THRESHOLD;
}

async function recordFailedAttempt(env, ip) {
  const key = `admin_lockout:${ip}`;
  const raw = await env.LCRCC_SIGNUPS_KV.get(key);
  const count = (Number(raw) || 0) + 1;
  await env.LCRCC_SIGNUPS_KV.put(key, String(count), { expirationTtl: LOCKOUT_WINDOW_SECONDS });
}

async function clearFailedAttempts(env, ip) {
  await env.LCRCC_SIGNUPS_KV.delete(`admin_lockout:${ip}`);
}

async function handleLogin(request, env) {
  const ip = clientIp(request);
  if (await isLockedOut(env, ip)) {
    return json({ error: "too many attempts, try again later" }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
  if (pin !== env.LCRCC_ADMIN_PIN) {
    await recordFailedAttempt(env, ip);
    return json({ error: "incorrect PIN" }, 401);
  }

  await clearFailedAttempts(env, ip);
  const token = await makeSessionToken(env.LCRCC_ADMIN_SIGNING_KEY);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`
  );
  return new Response(JSON.stringify({ ok: true }), { headers });
}

function handleLogout() {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  return new Response(JSON.stringify({ ok: true }), { headers });
}

function buildFilteredQuery(url) {
  const search = url.searchParams.get("search")?.trim() || "";
  const dateFrom = url.searchParams.get("date_from")?.trim() || "";
  const dateTo = url.searchParams.get("date_to")?.trim() || "";
  const amountMin = url.searchParams.get("amount_min")?.trim() || "";
  const amountMax = url.searchParams.get("amount_max")?.trim() || "";
  const method = url.searchParams.get("method")?.trim() || "";
  const sortByKey = url.searchParams.get("sort_by") || "date";
  const sortDir = url.searchParams.get("sort_dir") === "asc" ? "ASC" : "DESC";
  const sortColumn = SORT_COLUMNS[sortByKey] || SORT_COLUMNS.date;

  const where = [];
  const binds = [];

  if (search) {
    where.push("(first_name LIKE ? OR last_name LIKE ?)");
    binds.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) {
    where.push("contribution_date >= ?");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("contribution_date <= ?");
    binds.push(dateTo);
  }
  if (amountMin) {
    where.push("amount >= ?");
    binds.push(Number(amountMin));
  }
  if (amountMax) {
    where.push("amount <= ?");
    binds.push(Number(amountMax));
  }
  if (method) {
    where.push("payment_method = ?");
    binds.push(method);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // sortColumn comes only from the SORT_COLUMNS whitelist above, never
  // interpolated from raw user input - safe to inline despite not being a
  // bound parameter (D1 doesn't support parameterizing identifiers).
  const sql = `SELECT * FROM contributions ${whereClause} ORDER BY ${sortColumn} ${sortDir}, id DESC`;
  return { sql, binds };
}

async function handleList(request, env, url) {
  const { sql, binds } = buildFilteredQuery(url);
  const stmt = env.LCRCC_DB.prepare(sql).bind(...binds);
  const { results } = await stmt.all();
  return json({ contributions: results });
}

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function handleExport(request, env, url) {
  const { sql, binds } = buildFilteredQuery(url);
  const stmt = env.LCRCC_DB.prepare(sql).bind(...binds);
  const { results } = await stmt.all();

  const columns = ["first_name", "last_name", "address", "employer_occupation", "amount", "contribution_date", "payment_method", "notes"];
  const header = ["First Name", "Last Name", "Address", "Employer/Occupation", "Amount", "Date", "Payment Method", "Notes"];
  const lines = [header.join(",")];
  for (const row of results) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  const csv = lines.join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="lcrcc-contributions-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const first_name = typeof body?.first_name === "string" ? body.first_name.trim().slice(0, 200) : "";
  const last_name = typeof body?.last_name === "string" ? body.last_name.trim().slice(0, 200) : "";
  const address = typeof body?.address === "string" ? body.address.trim().slice(0, 300) : "";
  const employer_occupation = typeof body?.employer_occupation === "string" ? body.employer_occupation.trim().slice(0, 200) : "";
  const amount = Number(body?.amount);
  const contribution_date = typeof body?.contribution_date === "string" ? body.contribution_date.trim().slice(0, 10) : "";
  const payment_method = typeof body?.payment_method === "string" ? body.payment_method.trim().slice(0, 50) : "";
  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 1000) : "";

  if (!first_name || !last_name || !address || !Number.isFinite(amount) || amount <= 0 || !contribution_date) {
    return json({ error: "first name, last name, address, a positive amount, and date are required" }, 400);
  }

  const now = new Date().toISOString();
  const result = await env.LCRCC_DB.prepare(
    `INSERT INTO contributions (first_name, last_name, address, employer_occupation, amount, contribution_date, payment_method, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(first_name, last_name, address, employer_occupation, amount, contribution_date, payment_method, notes, now, now)
    .run();

  return json({ ok: true, id: result.meta.last_row_id });
}

async function handleUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const existing = await env.LCRCC_DB.prepare("SELECT id FROM contributions WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "not found" }, 404);

  const first_name = typeof body?.first_name === "string" ? body.first_name.trim().slice(0, 200) : "";
  const last_name = typeof body?.last_name === "string" ? body.last_name.trim().slice(0, 200) : "";
  const address = typeof body?.address === "string" ? body.address.trim().slice(0, 300) : "";
  const employer_occupation = typeof body?.employer_occupation === "string" ? body.employer_occupation.trim().slice(0, 200) : "";
  const amount = Number(body?.amount);
  const contribution_date = typeof body?.contribution_date === "string" ? body.contribution_date.trim().slice(0, 10) : "";
  const payment_method = typeof body?.payment_method === "string" ? body.payment_method.trim().slice(0, 50) : "";
  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 1000) : "";

  if (!first_name || !last_name || !address || !Number.isFinite(amount) || amount <= 0 || !contribution_date) {
    return json({ error: "first name, last name, address, a positive amount, and date are required" }, 400);
  }

  await env.LCRCC_DB.prepare(
    `UPDATE contributions SET first_name = ?, last_name = ?, address = ?, employer_occupation = ?, amount = ?, contribution_date = ?, payment_method = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(first_name, last_name, address, employer_occupation, amount, contribution_date, payment_method, notes, new Date().toISOString(), id)
    .run();

  return json({ ok: true });
}

async function handleDelete(env, id) {
  await env.LCRCC_DB.prepare("DELETE FROM contributions WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

export async function handleAdminApi(request, env, url) {
  const path = url.pathname;

  if (path === "/api/lcrcc/admin/login" && request.method === "POST") {
    return handleLogin(request, env);
  }
  if (path === "/api/lcrcc/admin/logout" && request.method === "POST") {
    return handleLogout();
  }

  // Everything below requires a valid session.
  if (!(await hasValidAdminSession(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (path === "/api/lcrcc/admin/contributions" && request.method === "GET") {
    return handleList(request, env, url);
  }
  if (path === "/api/lcrcc/admin/contributions/export" && request.method === "GET") {
    return handleExport(request, env, url);
  }
  if (path === "/api/lcrcc/admin/contributions" && request.method === "POST") {
    return handleCreate(request, env);
  }

  const idMatch = path.match(/^\/api\/lcrcc\/admin\/contributions\/(\d+)$/);
  if (idMatch && request.method === "PATCH") {
    return handleUpdate(request, env, Number(idMatch[1]));
  }
  if (idMatch && request.method === "DELETE") {
    return handleDelete(env, Number(idMatch[1]));
  }

  return json({ error: "not found" }, 404);
}

export function isLcrccAdminApiPath(pathname) {
  return pathname.startsWith("/api/lcrcc/admin/");
}
