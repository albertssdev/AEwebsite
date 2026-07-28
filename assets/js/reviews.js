(function () {
  var container = document.getElementById("google-reviews");
  if (!container) return;

  function stars(rating) {
    var full = Math.round(rating || 0);
    var out = "";
    for (var i = 0; i < 5; i++) {
      out += i < full ? "★" : "☆";
    }
    return out;
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  fetch("/api/reviews")
    .then(function (res) {
      if (!res.ok) throw new Error("bad response");
      return res.json();
    })
    .then(function (data) {
      var reviews = data.reviews || [];
      if (!reviews.length) {
        container.innerHTML = "";
        return;
      }
      var html = "";
      if (data.rating) {
        html +=
          '<p class="reviews-summary">' +
          '<span class="reviews-stars">' + stars(data.rating) + '</span> ' +
          data.rating.toFixed(1) + " rating" +
          (data.userRatingCount ? " of " + data.userRatingCount + " reviews" : "") +
          "</p>";
      }
      html += '<div class="reviews-cards">';
      reviews.forEach(function (r) {
        html +=
          '<div class="review-card">' +
          '<div class="review-stars">' + stars(r.rating) + "</div>" +
          '<p class="review-text">' + escapeHtml(r.text) + "</p>" +
          '<div class="review-meta">' +
          '<span class="review-author">' + escapeHtml(r.author) + "</span>" +
          '<span class="review-time">' + escapeHtml(r.relativeTime) + "</span>" +
          "</div>" +
          "</div>";
      });
      html += "</div>";
      container.innerHTML = html;
    })
    .catch(function () {
      container.innerHTML = "";
    });
})();
