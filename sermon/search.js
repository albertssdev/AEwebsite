// Sermon search — loads sermons.json (built from sermon_database.csv by
// scripts/build_sermons_json.py) and searches it in the browser.
//
// Search is deliberately literal, not fuzzy: every word you type must appear
// (as a substring, case-insensitive) somewhere in the sermon's text — title,
// speaker, summary, scripture references, topics, keywords, themes, tags.
// Results are ranked by where the words matched (a hit in the title outranks a
// hit in the summary). Full transcripts aren't in the data (too large to ship),
// so their content is represented by the AI-generated summary and keyword fields.

document.addEventListener("DOMContentLoaded", async () => {
  const els = {
    input: document.getElementById("searchInput"),
    speaker: document.getElementById("speakerSelect"),
    media: document.getElementById("mediaSelect"),
    sort: document.getElementById("sortSelect"),
    count: document.getElementById("count"),
    status: document.getElementById("status"),
    results: document.getElementById("results"),
    more: document.getElementById("moreBtn"),
  };

  const PAGE = 40;
  let shown = PAGE;
  let sermons = [];

  try {
    const res = await fetch("sermons.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sermons = await res.json();
  } catch (err) {
    els.status.textContent = "Could not load the sermon list. Please try again later.";
    els.status.classList.remove("hidden");
    console.error("Failed to load sermons.json:", err);
    return;
  }

  // Weighted fields: a query word matching here scores this much.
  const FIELDS = [
    ["title", 10],
    ["title_alt", 6],
    ["speaker", 6],
    ["scripture", 7],
    ["topics", 6],
    ["keywords", 6],
    ["themes", 4],
    ["seo", 3],
    ["series", 3],
    ["tone", 2],
    ["summary", 2],
  ];

  // Pre-lower every searchable field once.
  for (const s of sermons) {
    s._f = {};
    for (const [k] of FIELDS) {
      const v = s[k];
      s._f[k] = Array.isArray(v) ? v.join(" ").toLowerCase() : String(v || "").toLowerCase();
    }
    s._all = FIELDS.map(([k]) => s._f[k]).join("  ");
  }

  // Speaker dropdown from the data.
  for (const name of [...new Set(sermons.map((s) => s.speaker).filter(Boolean))].sort()) {
    els.speaker.insertAdjacentHTML("beforeend", `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`);
  }

  function scoreOf(s, words, phrase) {
    let score = 0;
    const wordToks = words.filter((w) => !/^\d+$/.test(w));
    const numToks = words.filter((w) => /^\d+$/.test(w));

    // Text words: substring match in any weighted field.
    const hitRefField = { title: false, scripture: false };
    for (const w of wordToks) {
      let best = 0;
      for (const [k, wt] of FIELDS) {
        if (s._f[k].includes(w)) {
          best = Math.max(best, wt);
          if (k === "title" || k === "scripture") hitRefField[k] = true;
        }
      }
      if (best === 0) return -1;
      score += best;
    }

    // Bare numbers are scripture chapters. Only count them where a word token
    // also landed (title or reference list) — keeps "1 john 3" from matching
    // every sermon that happens to contain a stray "1" and "3".
    for (const w of numToks) {
      const rx = new RegExp("\\b" + w + "\\b");
      let ok = false;
      for (const [k, wt] of [["title", 8], ["scripture", 6]]) {
        if ((wordToks.length === 0 || hitRefField[k]) && rx.test(s._f[k])) { score += wt; ok = true; break; }
      }
      if (!ok) return -1;
    }

    if (words.length > 1) {
      const rx = new RegExp("\\b" + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      if (rx.test(s._f.title)) score += 25;
      else if (rx.test(s._all)) score += 6;
    }
    // gentle tiebreak toward newer sermons
    return score + Math.min(idKey(s.id)[0], 300000) / 1e7;
  }

  function idKey(id) {
    const m = String(id).match(/(\d+)(.*)/);
    return m ? [parseInt(m[1], 10), m[2]] : [0, String(id)];
  }
  const cmp = (p, q) => (p[0] - q[0]) || String(p[1]).localeCompare(String(q[1]));

  function sortList(list, mode) {
    const a = list.slice();
    if (mode === "id-asc") return a.sort((x, y) => cmp(idKey(x.id), idKey(y.id)));
    if (mode === "id-desc") return a.sort((x, y) => cmp(idKey(y.id), idKey(x.id)));
    if (mode === "title-asc") return a.sort((x, y) => (x.title || "").localeCompare(y.title || ""));
    if (mode === "speaker-asc")
      return a.sort((x, y) => (x.speaker || "").localeCompare(y.speaker || "") || cmp(idKey(y.id), idKey(x.id)));
    return a;
  }

  function current() {
    const raw = els.input.value.trim().toLowerCase();
    // keep words of 2+ chars, plus bare numbers (scripture chapters: "romans 8", "1 john")
    const words = raw.split(/\s+/).filter((w) => w.length >= 2 || /^\d+$/.test(w));
    let list;

    if (words.length) {
      list = sermons
        .map((s) => ({ s, sc: scoreOf(s, words, raw) }))
        .filter((x) => x.sc >= 0)
        .sort((a, b) => b.sc - a.sc)
        .map((x) => x.s);
    } else {
      list = sermons.slice();
    }

    const sp = els.speaker.value;
    const md = els.media.value;
    if (sp) list = list.filter((s) => s.speaker === sp);
    if (md) list = list.filter((s) => s.media === md);

    let mode = els.sort.value;
    if (mode === "relevance") return words.length ? list : sortList(list, "id-desc");
    return sortList(list, mode);
  }

  function fmtDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || "");
    if (!m) return d || "";
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m[2] - 1];
    return `${mon} ${+m[3]}, ${m[1]}`;
  }
  function fmtDur(sec) {
    if (!sec) return "";
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
  }

  function card(s) {
    const meta = [s.speaker, fmtDate(s.date), fmtDur(s.dur)].filter(Boolean).join(" &middot; ");
    const badge = s.media === "video"
      ? `<span class="text-xs font-medium text-red-700 bg-red-50 rounded px-1.5 py-0.5">Video</span>`
      : s.media === "audio"
        ? `<span class="text-xs font-medium text-blue-700 bg-blue-50 rounded px-1.5 py-0.5">Audio</span>`
        : "";
    const action = s.url
      ? `<a href="${escapeAttr(s.url)}" target="_blank" rel="noopener"
            class="text-blue-700 hover:underline font-medium whitespace-nowrap">${s.media === "video" ? "Watch" : "Listen"} &rarr;</a>`
      : "";
    const summary = s.summary
      ? `<p class="text-sm text-gray-600 mt-2 clamp-3">${escapeHtml(s.summary)}</p>`
      : "";
    const chipVals = [...(s.scripture || []).slice(0, 3), ...(s.topics || []).slice(0, 4)].slice(0, 6);
    const chips = chipVals.length
      ? `<div class="flex flex-wrap gap-1.5 mt-2">` +
        chipVals.map((c) =>
          `<button data-chip="${escapeAttr(c)}" class="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded px-2 py-0.5">${escapeHtml(c)}</button>`
        ).join("") + `</div>`
      : "";

    return `
      <div class="bg-white border border-gray-200 rounded-lg p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-semibold text-gray-900">${escapeHtml(s.title || "Untitled")} ${badge}</p>
            <p class="text-sm text-gray-500 mt-0.5">${meta}</p>
          </div>
          ${action}
        </div>
        ${summary}
        ${chips}
      </div>`;
  }

  function render() {
    const list = current();
    const q = els.input.value.trim();

    els.count.textContent = list.length === sermons.length
      ? `${sermons.length} sermons`
      : `${list.length} of ${sermons.length} sermons`;

    if (!list.length) {
      els.results.innerHTML = `<p class="text-gray-500 py-8 text-center">No sermons match ${q ? `&ldquo;${escapeHtml(q)}&rdquo;` : "those filters"}.</p>`;
      els.more.classList.add("hidden");
      return;
    }

    els.results.innerHTML = list.slice(0, shown).map(card).join("");
    if (list.length > shown) {
      els.more.textContent = `Show ${Math.min(PAGE, list.length - shown)} more (${list.length - shown} left)`;
      els.more.classList.remove("hidden");
    } else {
      els.more.classList.add("hidden");
    }
  }

  function reset() { shown = PAGE; render(); }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  els.input.addEventListener("input", debounce(reset, 150));
  els.speaker.addEventListener("change", reset);
  els.media.addEventListener("change", reset);
  els.sort.addEventListener("change", reset);
  els.more.addEventListener("click", () => { shown += PAGE; render(); });
  els.results.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-chip]");
    if (!chip) return;
    els.input.value = chip.dataset.chip;
    els.sort.value = "relevance";
    reset();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  render();
});
