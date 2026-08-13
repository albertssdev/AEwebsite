(function () {
  var countEl = document.getElementById("visitsCount");
  if (!countEl) return;

  fetch("/api/visits")
    .then(function (res) {
      if (!res.ok) throw new Error("bad response");
      return res.json();
    })
    .then(function (data) {
      countEl.textContent = (data.total || 0).toLocaleString();
    })
    .catch(function () {
      var widget = document.getElementById("visitsWidget");
      if (widget) widget.style.display = "none";
    });
})();
