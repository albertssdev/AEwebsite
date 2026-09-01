// Sermon search. Loads sermons.json (built from sermon_database.csv by
// scripts/build_sermons_json.py) and searches it three ways, blended:
//
//   literal   — every word you type must appear (substring), weighted by field
//   fuzzy     — a misspelled word is spelling-corrected against the corpus
//               vocabulary (bounded edit distance) so small typos still match
//   semantic  — sentence-embedding similarity (all-MiniLM-L6-v2 via
//               transformers.js) so a search like "God's grace" also turns up
//               sermons about grace that don't use those exact words
//
// The page works on literal + fuzzy immediately; semantic results fold in once
// the model has loaded. Layout and colours match the original Sermon Search
// page. Full transcripts aren't in the data (too large to ship) — the summary,
// scripture and keyword fields carry the searchable content drawn from them.

document.addEventListener("DOMContentLoaded", async function () {
  const searchInput = document.getElementById("searchInput");
  const speakerSelect = document.getElementById("speakerSelect");
  const mediaSelect = document.getElementById("mediaSelect");
  const sortSelect = document.getElementById("sortSelect");
  const resultsDiv = document.getElementById("results");
  const loadingDiv = document.getElementById("loading");
  const countP = document.getElementById("count");

  const ITEMS_PER_LOAD = 15;
  let sermons = [];
  let vecs = null;                 // id -> Float32Array (unit-normalised)
  let queryVec = null, queryVecFor = "";
  let currentList = [];
  let displayed = 0;

  // ---- load data -------------------------------------------------------
  try {
    const r = await fetch("sermons.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    sermons = await r.json();
  } catch (e) {
    console.error("Error fetching sermons:", e);
    resultsDiv.innerHTML = '<p class="text-red-500">Error loading sermons. Please try again later.</p>';
    return;
  }

  const FIELDS = [
    ["title", 10], ["title_alt", 6], ["speaker", 6], ["scripture", 7],
    ["topics", 6], ["keywords", 6], ["themes", 4], ["seo", 3],
    ["series", 3], ["tone", 2], ["summary", 2],
  ];
  const STOP = new Set(("the of a an and or to in is are was for on by with as at from that this " +
    "be it he she they we you i his her their our your my not no do does did have has had will " +
    "what which who how when where why can could would should").split(" "));
  const BOOKS = new Set(("genesis exodus leviticus numbers deuteronomy joshua judges ruth samuel kings " +
    "chronicles ezra nehemiah esther job psalm psalms proverbs ecclesiastes isaiah jeremiah lamentations " +
    "ezekiel daniel hosea joel amos obadiah jonah micah nahum habakkuk zephaniah haggai zechariah malachi " +
    "matthew mark luke john acts romans corinthians galatians ephesians philippians colossians thessalonians " +
    "timothy titus philemon hebrews james peter jude revelation").split(" "));
  const VOCAB = new Set();
  for (const s of sermons) {
    s._f = {};
    for (const [k] of FIELDS) {
      const v = s[k];
      s._f[k] = Array.isArray(v) ? v.join(" ").toLowerCase() : String(v || "").toLowerCase();
    }
    s._all = FIELDS.map(([k]) => s._f[k]).join("  ");
    for (const w of s._all.match(/[a-z][a-z'-]{2,}/g) || []) VOCAB.add(w);
  }
  const VOCAB_LIST = [...VOCAB];

  // bounded Levenshtein — returns max+1 as soon as it's clear the distance
  // exceeds `max`, so scanning the whole vocabulary stays cheap
  function lev(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let prev = Array.from({ length: lb + 1 }, (_, j) => j);
    for (let i = 1; i <= la; i++) {
      const cur = [i];
      let rowMin = i;
      const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (ai === b.charCodeAt(j - 1) ? 0 : 1));
        cur.push(v);
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[lb];
  }

  // spelling correction: a query word with no literal match anywhere is mapped
  // to the closest corpus word(s) within a small edit distance — this is the
  // fuzzy layer ("jstification" -> "justification", "fayth" -> "faith")
  const correctCache = new Map();
  function correct(w) {
    if (correctCache.has(w)) return correctCache.get(w);
    const max = w.length <= 6 ? 1 : 2;
    let best = max + 1, hits = [];
    for (const v of VOCAB_LIST) {
      if (Math.abs(v.length - w.length) > best) continue;
      const d = lev(w, v, best);
      if (d < best) { best = d; hits = [v]; }
      else if (d === best) hits.push(v);
    }
    const out = best <= max ? hits.slice(0, 8) : [];
    correctCache.set(w, out);
    return out;
  }

  // ---- speaker dropdown ----------------------------------------------
  for (const name of [...new Set(sermons.map((s) => s.speaker).filter(Boolean))].sort()) {
    const o = document.createElement("option");
    o.value = name; o.textContent = name;
    speakerSelect.appendChild(o);
  }

  // ---- semantic embeddings (async) ----------------------------------
  (async () => {
    try {
      const r = await fetch("embeddings.json", { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const e = await r.json();
      const raw = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
      const dim = e.dim, scale = e.scale || (1 / 127);
      vecs = new Map();
      for (let i = 0; i < e.ids.length; i++) {
        const v = new Float32Array(dim);
        let n = 0;
        for (let d = 0; d < dim; d++) {
          const x = ((raw[i * dim + d] << 24) >> 24) * scale;
          v[d] = x; n += x * x;
        }
        n = Math.sqrt(n) || 1;
        for (let d = 0; d < dim; d++) v[d] /= n;
        vecs.set(e.ids[i], v);
      }
    } catch (err) {
      console.warn("sermon embeddings unavailable:", err);
    }
  })();
  window.addEventListener("semantic-ready", () => { if (searchInput.value.trim()) reset(); });

  // ---- scoring -------------------------------------------------------
  function idNum(id) { const m = String(id).match(/\d+/); return m ? parseInt(m[0], 10) : 0; }
  function idKey(id) { const m = String(id).match(/(\d+)(.*)/); return m ? [parseInt(m[1], 10), m[2]] : [0, String(id)]; }
  const icmp = (p, q) => (p[0] - q[0]) || String(p[1]).localeCompare(String(q[1]));

  const ORD = { "1": "first", "2": "second", "3": "third" };
  const numRe = (n) => new RegExp(ORD[n] ? `(\\b${n}\\b|\\b${ORD[n]}\\b)` : `\\b${n}\\b`);

  // A lexical hit needs EVERY word group to appear somewhere (each group is one
  // query word plus, if it was misspelled, its spelling-corrected forms — any
  // one of them counts). A number token ("romans 8", "matthew 24") counts only
  // in the title (where a word also matched) or in a scripture entry whose book
  // is one of the query words — so it filters by chapter/book, not a wildcard.
  function lexScore(s, groups, nums, phrase, ref) {
    let score = 0;
    let wordInTitle = false;
    let anyFuzzy = false;
    for (const g of groups) {
      let best = 0;
      for (const [k, wt] of FIELDS) {
        if (g.forms.some((f) => s._f[k].includes(f))) {
          best = Math.max(best, wt);
          if (k === "title") wordInTitle = true;
        }
      }
      if (!best) return 0;
      score += g.fuzzy ? best * 0.7 : best;
      if (g.fuzzy) anyFuzzy = true;
    }
    const scr = (s.scripture || []).map((e) => e.toLowerCase());
    const firstAlpha = (e) => (e.match(/[a-z]+/) || [""])[0];
    if (ref) {
      // "romans 8" -> the chapter itself or a range through it ("8:1-14",
      // "8:29-9:7"), NOT a lone "Romans 8:28" cited in passing. Weight by where
      // it lands: title > primary (first) scripture > any other.
      const hit = (t) => ref.whole.test(t) || ref.range.test(t);
      if (hit(s._f.title)) score += 30;
      else if (scr.length && hit(scr[0])) score += 20;
      else if (scr.some(hit)) score += 12;
      else return 0;
    } else {
      for (const n of nums) {
        const rx = numRe(n);
        const inTitle = rx.test(s._f.title) && (!groups.length || wordInTitle);
        const inScr = scr.some((e) => rx.test(e) &&
          (!groups.length || groups.some((g) => g.forms.some((f) =>
            firstAlpha(e).startsWith(f) || f.startsWith(firstAlpha(e))))));
        if (!inTitle && !inScr) return 0;
        score += inTitle ? 8 : 6;
      }
    }
    if (!anyFuzzy && groups.length + nums.length > 1) {
      const rx = new RegExp("\\b" + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      if (rx.test(s._f.title)) score += 25;
      else if (rx.test(s._all)) score += 5;
    }
    return score;
  }
  const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

  async function ensureQueryVec(q) {
    if (queryVecFor === q) return queryVec;
    if (!window.__semantic || !window.__semantic.ready || !vecs) return null;
    try {
      const v = await window.__semantic.embed(q);
      const n = Math.sqrt(dot(v, v)) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      queryVec = v; queryVecFor = q;
      return v;
    } catch (e) { console.warn("query embed failed:", e); return null; }
  }

  const SEM_ENTER = 0.42;   // enter on semantics alone at/above this similarity
  const SEM_TOPN = 20;      // ...and only if in the top N by similarity
  const SEM_FLOOR = 0.30;   // below this, semantics don't nudge the ranking
  const SEM_Z = 3.0;        // ...or a clear statistical outlier for this query
  const SEM_Z_MIN = 0.33;   // ...but never below this raw similarity

  function rankedForQuery(raw, qv) {
    const toks = raw.split(/\s+/).filter(Boolean);
    const rawWords = toks.filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w));
    const nums = toks.filter((w) => /^\d+$/.test(w));
    if (!rawWords.length && !nums.length) return null;

    // each word becomes a group: the word itself if it appears literally
    // anywhere, otherwise its spelling-corrected forms (the fuzzy layer)
    const groups = rawWords.map((w) => {
      if (sermons.some((s) => s._all.includes(w))) return { forms: [w], fuzzy: false };
      const c = w.length >= 4 ? correct(w) : [];
      return c.length ? { forms: c, fuzzy: true } : { forms: [w], fuzzy: false };
    });
    const anyFuzzy = groups.some((g) => g.fuzzy);

    // a scripture-reference query ("romans 8", "matthew 24", "1 john 3") — Bible
    // book(s) plus a chapter — is precise by nature. Match book+chapter and keep
    // semantics out so it doesn't drag in 100 loosely-related sermons.
    let book = null, chap = null;
    for (let i = 0; i < toks.length; i++) {
      if (BOOKS.has(toks[i])) {
        const ord = i > 0 && /^[123]$/.test(toks[i - 1]) ? toks[i - 1] + "\\s+" : "";
        book = ord + toks[i] + "s?";                       // plural-tolerant (psalm/psalms)
        for (let j = i + 1; j < toks.length; j++)
          if (/^\d+$/.test(toks[j])) { chap = toks[j]; break; }
        break;
      }
    }
    const isRefQuery = chap != null && rawWords.every((w) => BOOKS.has(w));
    let ref = null;
    if (isRefQuery) {
      const base = "\\b" + book + "\\s+" + chap;
      ref = {
        whole: new RegExp(base + "(?![:\\d])"),            // "romans 8"
        range: new RegExp(base + ":\\d+\\s*[-\\u2013]"),   // "romans 8:1-14"
      };
    }

    const lex = new Map(), semAll = new Map();
    let lexMax = 0;
    for (const s of sermons) {
      const v = lexScore(s, groups, nums, raw, ref);
      if (v > 0) { lex.set(s.id, v); if (v > lexMax) lexMax = v; }
    }

    const semEnter = new Set();
    if (qv && vecs && (!isRefQuery || lex.size < 3)) {
      const sims = [];
      let sum = 0, sum2 = 0;
      for (const s of sermons) {
        const sv = vecs.get(s.id);
        if (sv) { const c = dot(qv, sv); semAll.set(s.id, c); sims.push([s.id, c]); sum += c; sum2 += c * c; }
      }
      const mu = sum / sims.length;
      const sd = Math.sqrt(Math.max(0, sum2 / sims.length - mu * mu)) || 1;
      sims.sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < Math.min(SEM_TOPN, sims.length); i++) {
        const c = sims[i][1];
        if (c >= SEM_ENTER || (c >= SEM_Z_MIN && (c - mu) / sd >= SEM_Z))
          semEnter.add(sims[i][0]);
      }
    }

    const byId = new Map(sermons.map((s) => [s.id, s]));
    const out = [];
    for (const id of new Set([...lex.keys(), ...semEnter])) {
      const isLex = lex.has(id);
      const l = lexMax ? (lex.get(id) || 0) / lexMax : 0;
      const c = semAll.get(id) || 0;
      const sN = c > SEM_FLOOR ? (c - SEM_FLOOR) / (1 - SEM_FLOOR) : 0;
      const final = 1.0 * l + 0.55 * sN + (isLex ? 0.2 : 0);
      if (isLex || semEnter.has(id)) out.push([byId.get(id), final]);
    }
    out.sort((a, b) => b[1] - a[1]);
    return out.map((x) => x[0]);
  }

  function sortSermons(list, mode) {
    const [field, dir] = mode.split("-");
    const a = list.slice();
    a.sort((x, y) => {
      let A, B;
      if (field === "title") { A = x.title || ""; B = y.title || ""; }
      else if (field === "speaker") { A = x.speaker || ""; B = y.speaker || ""; }
      else if (field === "date") {
        A = x.date || "9999-99-99"; B = y.date || "9999-99-99";  // blanks last for asc
        if (dir === "desc") { A = x.date || "0000-00-00"; B = y.date || "0000-00-00"; }
      } else { return dir === "asc" ? icmp(idKey(x.id), idKey(y.id)) : icmp(idKey(y.id), idKey(x.id)); }
      if (A === B) return icmp(idKey(y.id), idKey(x.id));
      return dir === "asc" ? (A < B ? -1 : 1) : (A > B ? -1 : 1);
    });
    return a;
  }

  // ---- render (original layout / colours) --------------------------
  function fmtDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || "");
    if (!m) return "";
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m[2] - 1];
    return `${mon} ${+m[3]}, ${m[1]}`;
  }
  function fmtDur(sec) {
    if (!sec) return "";
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
  }

  function paint(append) {
    if (!append) { resultsDiv.innerHTML = ""; displayed = 0; }
    if (!currentList.length && !displayed) {
      resultsDiv.innerHTML = '<p class="text-gray-500">No results found.</p>';
      loadingDiv.classList.add("hidden");
      return;
    }
    const end = Math.min(displayed + ITEMS_PER_LOAD, currentList.length);
    for (let i = displayed; i < end; i++) {
      const s = currentList[i];
      const div = document.createElement("div");
      div.className = "border-2 border-black p-2 rounded-lg shadow bg-white";

      const p = document.createElement("p");
      p.className = "text-base";

      const titleSpan = document.createElement("span");
      titleSpan.className = "font-bold text-blue-500 underline";
      if (s.url) {
        const a = document.createElement("a");
        a.href = encodeURI(s.url);
        a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = s.title || "N/A";
        titleSpan.appendChild(a);
      } else {
        titleSpan.textContent = s.title || "N/A";
      }
      p.appendChild(titleSpan);

      const rest = [s.speaker, fmtDate(s.date), fmtDur(s.dur)].filter(Boolean).join("  ");
      const restSpan = document.createElement("span");
      restSpan.textContent = rest ? "  by: " + rest : "";
      p.appendChild(restSpan);

      div.appendChild(p);
      resultsDiv.appendChild(div);
    }
    displayed = end;
    loadingDiv.classList.toggle("hidden", displayed >= currentList.length);
  }

  async function render() {
    const raw = searchInput.value.trim();
    const qv = raw ? await ensureQueryVec(raw.toLowerCase()) : null;

    let list = raw ? (rankedForQuery(raw.toLowerCase(), qv) || []) : sermons.slice();

    const sp = speakerSelect.value, md = mediaSelect.value;
    if (sp) list = list.filter((s) => s.speaker === sp);
    if (md) list = list.filter((s) => s.media === md);

    let mode = sortSelect.value;
    if (mode === "relevance") { if (!raw) list = sortSermons(list, "number-desc"); }
    else list = sortSermons(list, mode);

    currentList = list;
    countP.textContent = list.length === sermons.length
      ? `${sermons.length} sermons`
      : `${list.length} of ${sermons.length} sermons`;
    paint(false);
  }

  function reset() { displayed = 0; render(); }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  searchInput.addEventListener("input", debounce(reset, 250));
  speakerSelect.addEventListener("change", reset);
  mediaSelect.addEventListener("change", reset);
  sortSelect.addEventListener("change", reset);
  window.addEventListener("scroll", debounce(() => {
    if (displayed < currentList.length &&
        window.innerHeight + window.scrollY >= document.body.offsetHeight - 120) {
      paint(true);
    }
  }, 100));

  render();
});
