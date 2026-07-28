const HISTORY_KEY = "history";
const MAX_ENTRIES = 200;

// Simple read-modify-write over a single KV key. Fine at personal-use request
// volume; not safe under real concurrent writes (KV has no transactions), which
// is an acceptable tradeoff here rather than reaching for D1 for a single-user tool.
export async function logRoute(env, query, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    query,
    taskType: result.taskType,
    reason: result.reason,
    attempts: result.attempts,
    usedProvider: result.result?.provider ?? null,
    usedModel: result.result?.model ?? null,
    failed: result.failed,
  };

  const existingRaw = await env.HIVE_LOGS_KV.get(HISTORY_KEY);
  const existing = existingRaw ? JSON.parse(existingRaw) : [];
  existing.unshift(entry);
  await env.HIVE_LOGS_KV.put(HISTORY_KEY, JSON.stringify(existing.slice(0, MAX_ENTRIES)));
}

export async function readRecentLogs(env, limit) {
  const raw = await env.HIVE_LOGS_KV.get(HISTORY_KEY);
  const all = raw ? JSON.parse(raw) : [];
  return all.slice(0, limit);
}
