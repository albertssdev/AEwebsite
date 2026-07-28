document.addEventListener('DOMContentLoaded', function () {
  var stickyBtn = document.getElementById('stickyBtn');
  var ctaButton = document.getElementById('ctaCallBtn');

  if (stickyBtn && ctaButton) {
    var updateSticky = function () {
      var rect = ctaButton.getBoundingClientRect();
      if (rect.top <= 10) {
        stickyBtn.style.display = 'block';
        ctaButton.style.visibility = 'hidden';
      } else {
        stickyBtn.style.display = 'none';
        ctaButton.style.visibility = 'visible';
      }
    };
    window.addEventListener('scroll', updateSticky, { passive: true });
    window.addEventListener('resize', updateSticky);
    updateSticky();
  }

  var yearEl = document.getElementById('year');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
});