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
      html += '<div class="reviews-carousel">';
      html += '<button type="button" class="carousel-btn prev" aria-label="Previous review">&#8249;</button>';
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
      html += '<button type="button" class="carousel-btn next" aria-label="Next review">&#8250;</button>';
      html += "</div>";
      container.innerHTML = html;

      var track = container.querySelector(".reviews-cards");
      var prevBtn = container.querySelector(".carousel-btn.prev");
      var nextBtn = container.querySelector(".carousel-btn.next");

      function scrollByCard(direction) {
        var card = track.querySelector(".review-card");
        if (!card) return;
        var style = window.getComputedStyle(track);
        var gap = parseFloat(style.columnGap || style.gap || 0) || 0;
        track.scrollBy({ left: direction * (card.offsetWidth + gap), behavior: "smooth" });
      }

      prevBtn.addEventListener("click", function () { scrollByCard(-1); });
      nextBtn.addEventListener("click", function () { scrollByCard(1); });

      function updateButtons() {
        var maxScroll = track.scrollWidth - track.clientWidth;
        var atStart = track.scrollLeft <= 1;
        var atEnd = track.scrollLeft >= maxScroll - 1;
        prevBtn.style.visibility = atStart ? "hidden" : "visible";
        nextBtn.style.visibility = maxScroll <= 1 || atEnd ? "hidden" : "visible";
      }

      track.addEventListener("scroll", updateButtons);
      window.addEventListener("resize", updateButtons);
      updateButtons();
    })
    .catch(function () {
      container.innerHTML = "";
    });
})();
