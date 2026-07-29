const LIST_KEY = "conv:list";
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 200;

function convKey(id) {
  return `conv:${id}`;
}

export function makeTitle(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New chat";
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

export async function listConversations(env, limit = 50) {
  const raw = await env.HIVE_LOGS_KV.get(LIST_KEY);
  const all = raw ? JSON.parse(raw) : [];
  return all.slice(0, limit);
}

export async function getConversation(env, id) {
  const raw = await env.HIVE_LOGS_KV.get(convKey(id));
  return raw ? JSON.parse(raw) : null;
}

// Same read-modify-write caveat as the old history log: fine for personal-scale,
// single-user traffic, not safe under real concurrent writes to the same conversation.
export async function saveConversation(env, conv) {
  if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  }
  await env.HIVE_LOGS_KV.put(convKey(conv.id), JSON.stringify(conv));

  const raw = await env.HIVE_LOGS_KV.get(LIST_KEY);
  const all = raw ? JSON.parse(raw) : [];
  const filtered = all.filter((c) => c.id !== conv.id);
  filtered.unshift({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt });
  await env.HIVE_LOGS_KV.put(LIST_KEY, JSON.stringify(filtered.slice(0, MAX_CONVERSATIONS)));
}

export async function deleteConversation(env, id) {
  await env.HIVE_LOGS_KV.delete(convKey(id));
  const raw = await env.HIVE_LOGS_KV.get(LIST_KEY);
  const all = raw ? JSON.parse(raw) : [];
  await env.HIVE_LOGS_KV.put(LIST_KEY, JSON.stringify(all.filter((c) => c.id !== id)));
}
