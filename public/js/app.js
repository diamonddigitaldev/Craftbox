// Global Craftbox scripts — loaded on every page

// Initialize Bootstrap toasts (auto-show flash messages)
document.querySelectorAll('.toast').forEach(function (el) {
    new bootstrap.Toast(el).show();
});
