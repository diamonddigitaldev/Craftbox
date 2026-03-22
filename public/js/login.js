(function () {
    var form = document.querySelector('form[action="/login"]');
    if (!form) return;
    form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Signing In...';
    });
})();
