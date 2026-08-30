// Sermon search — loads sermonlist.json, fuzzy-searches it with Fuse.js.
// The data is small (~100 rows) so everything renders client-side at once;
// no pagination or infinite scroll needed.

document.addEventListener("DOMContentLoaded", async () => {
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");
  const resultsDiv = document.getElementById("results");
  const countDiv = document.getElementById("count");
  const statusDiv = document.getElementById("status");

  let sermons = [];
  let fuse = null;

  try {
    const res = await fetch("sermonlist.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sermons = await res.json();
  } catch (err) {
    statusDiv.textContent = "Could not load the sermon list. Please try again later.";
    statusDiv.classList.remove("hidden");
    console.error("Failed to load sermonlist.json:", err);
    return;
  }

  fuse = new Fuse(sermons, {
    keys: [
      { name: "Sermon Title", weight: 0.7 },
      { name: "Name", weight: 0.2 },
      { name: "Keywords", weight: 0.1 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  function sortSermons(list, mode) {
    const sorted = list.slice();
    switch (mode) {
      case "id-asc":
        return sorted.sort((a, b) => a.ID - b.ID);
      case "title-asc":
        return sorted.sort((a, b) =>
          (a["Sermon Title"] || "").localeCompare(b["Sermon Title"] || ""));
      case "speaker-asc":
        return sorted.sort((a, b) =>
          (a.Name || "").localeCompare(b.Name || "") ||
          b.ID - a.ID);
      case "id-desc":
      default:
        return sorted.sort((a, b) => b.ID - a.ID);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function render() {
    const query = searchInput.value.trim();
    const base = query.length >= 2
      ? fuse.search(query).map((r) => r.item)
      : sermons;

    // Fuse returns results in relevance order; only re-sort when there's no
    // active query, or when the user explicitly picked a sort other than the
    // default.
    const mode = sortSelect.value;
    const list = (query.length >= 2 && mode === "id-desc")
      ? base
      : sortSermons(base, mode);

    countDiv.textContent = list.length === sermons.length
      ? `${sermons.length} sermons`
      : `${list.length} of ${sermons.length} sermons`;

    if (list.length === 0) {
      resultsDiv.innerHTML =
        `<p class="text-gray-500 py-8 text-center">No sermons match &ldquo;${escapeHtml(query)}&rdquo;.</p>`;
      return;
    }

    resultsDiv.innerHTML = list.map((s) => {
      const title = escapeHtml(s["Sermon Title"] || "Untitled");
      const speaker = escapeHtml(s.Name || "Unknown speaker");
      const date = s.Date ? escapeHtml(s.Date) : "";
      const listen = s.URL
        ? `<a href="${escapeHtml(s.URL)}" target="_blank" rel="noopener"
              class="text-blue-700 hover:underline whitespace-nowrap ml-4">Listen &rarr;</a>`
        : "";
      return `
        <div class="flex items-start justify-between border-b border-gray-200 py-3">
          <div>
            <p class="font-medium text-gray-900">${title}</p>
            <p class="text-sm text-gray-600">${speaker}${date ? ` &middot; ${date}` : ""}</p>
          </div>
          ${listen}
        </div>`;
    }).join("");
  }

  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  searchInput.addEventListener("input", debounce(render, 200));
  sortSelect.addEventListener("change", render);
  render();
});
