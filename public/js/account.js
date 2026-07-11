document.addEventListener('DOMContentLoaded', function () {
    var csrfToken = document.querySelector('input[name="_csrf"]').value;

    // ═══════════════════════════════════════════
    // Change Username / Password
    // ═══════════════════════════════════════════

    var confirmSaveBtn = document.getElementById('confirmSaveBtn');
    var saveBtn = document.getElementById('saveBtn');
    var form = document.getElementById('accountForm');
    var currentPwField = document.getElementById('currentPassword');
    var newUsernameField = document.getElementById('newUsername');
    var newPasswordField = document.getElementById('newPassword');
    var confirmPwField = document.getElementById('confirmNewPassword');

    function checkForm() {
        var hasCurrent = currentPwField.value.length > 0;
        var hasChange = newUsernameField.value.trim().length > 0 || newPasswordField.value.length > 0;
        saveBtn.disabled = !(hasCurrent && hasChange);
    }

    form.addEventListener('input', checkForm);
    form.addEventListener('change', checkForm);
    checkForm();

    confirmSaveBtn.addEventListener('click', function () {
        confirmSaveBtn.disabled = true;
        confirmSaveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        bootstrap.Modal.getInstance(document.getElementById('confirmModal')).hide();
        form.method = 'POST';
        form.action = '/account';
        showOverlay('Saving account...', 'Please wait while your changes are applied.');
        form.submit();
    });

    form.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (!saveBtn.disabled) saveBtn.click();
        }
    });

    var confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
    saveBtn.addEventListener('click', function () {
        if (!form.reportValidity()) return;

        var newPassword = newPasswordField.value;
        var confirmPw = confirmPwField.value;

        if (newPassword && newPassword !== confirmPw) {
            confirmPwField.setCustomValidity('Passwords do not match.');
            confirmPwField.reportValidity();
            confirmPwField.setCustomValidity('');
            return;
        }

        confirmModal.show();
    });

    // ═══════════════════════════════════════════
    // API Keys — Create
    // ═══════════════════════════════════════════

    var createKeyModal = new bootstrap.Modal(document.getElementById('createKeyModal'));
    var showKeyModal = new bootstrap.Modal(document.getElementById('showKeyModal'));
    var deleteKeyModal = new bootstrap.Modal(document.getElementById('deleteKeyModal'));

    var createKeyBtn = document.getElementById('create-key-btn');
    var createKeyForm = document.getElementById('create-key-form');
    var keyNameInput = document.getElementById('keyName');
    var confirmCreateBtn = document.getElementById('confirm-create-key-btn');

    // Only enable "Generate Key" while the name is valid (non-blank and matches the input's pattern)
    function checkKeyName() {
        confirmCreateBtn.disabled = !(keyNameInput.checkValidity() && keyNameInput.value.trim().length > 0);
    }

    keyNameInput.addEventListener('input', checkKeyName);

    if (createKeyBtn) {
        createKeyBtn.addEventListener('click', function () {
            keyNameInput.value = '';
            keyNameInput.setCustomValidity('');
            checkKeyName();
            createKeyModal.show();
        });
    }

    // Bootstrap's shown.bs.modal fires after its own focus logic has settled,
    // so focusing here sticks (setTimeout races and loses).
    document.getElementById('createKeyModal').addEventListener('shown.bs.modal', function () {
        keyNameInput.focus();
    });

    if (createKeyForm) {
        createKeyForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!createKeyForm.reportValidity()) return;

            var name = keyNameInput.value.trim();
            if (!name) return;

            confirmCreateBtn.disabled = true;
            createKeyModal.hide();
            showOverlay('Generating key...', 'Please wait while the key is created.');

            try {
                var res = await fetch('/api/v1/account/apikeys', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    },
                    body: JSON.stringify({ name: name })
                });
                var data = await res.json().catch(function () { return {}; });
                if (!res.ok) {
                    hideOverlay();
                    confirmCreateBtn.disabled = false;
                    showToast(data.message || data.error || 'Failed to generate key.', 'danger');
                    return;
                }

                hideOverlay();
                confirmCreateBtn.disabled = false;
                document.getElementById('generatedKeyValue').value = data.key;
                showKeyModal.show();
            } catch (err) {
                hideOverlay();
                confirmCreateBtn.disabled = false;
                showToast('Network error: ' + err.message, 'danger');
            }
        });
    }

    // Copy the generated key to the clipboard
    var copyKeyBtn = document.getElementById('copy-key-btn');
    if (copyKeyBtn) {
        copyKeyBtn.addEventListener('click', async function () {
            var input = document.getElementById('generatedKeyValue');
            try {
                await navigator.clipboard.writeText(input.value);
                copyKeyBtn.innerHTML = '<span class="material-icons-outlined" style="font-size: 1.1rem;">check</span>';
                setTimeout(function () {
                    copyKeyBtn.innerHTML = '<span class="material-icons-outlined" style="font-size: 1.1rem;">content_copy</span>';
                }, 1500);
            } catch (err) {
                // Fallback: select the input
                input.select();
                try { document.execCommand('copy'); } catch (_) {}
            }
        });
    }

    // "I've saved it" closes the show-key modal and reloads so the new key appears in the table
    var savedKeyBtn = document.getElementById('saved-key-btn');
    if (savedKeyBtn) {
        savedKeyBtn.addEventListener('click', function () {
            showKeyModal.hide();
            window.location.reload();
        });
    }

    // ═══════════════════════════════════════════
    // API Keys — Delete
    // ═══════════════════════════════════════════

    var pendingDeleteId = null;

    document.querySelectorAll('.delete-key-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            pendingDeleteId = btn.getAttribute('data-key-id');
            document.getElementById('deleteKeyName').textContent = btn.getAttribute('data-key-name') || '';
            document.getElementById('deleteKeyPrefix').textContent = btn.getAttribute('data-key-prefix') || '';
            deleteKeyModal.show();
        });
    });

    var confirmDeleteBtn = document.getElementById('confirm-delete-key-btn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', async function () {
            if (!pendingDeleteId) return;

            confirmDeleteBtn.disabled = true;
            deleteKeyModal.hide();
            showOverlay('Deleting key...', 'Please wait while the key is removed.');

            try {
                var res = await fetch('/api/v1/account/apikeys/' + encodeURIComponent(pendingDeleteId), {
                    method: 'DELETE',
                    headers: { 'X-CSRF-Token': csrfToken }
                });

                if (!res.ok && res.status !== 204) {
                    var data = await res.json().catch(function () { return {}; });
                    hideOverlay();
                    confirmDeleteBtn.disabled = false;
                    showToast(data.message || data.error || 'Failed to delete key.', 'danger');
                    return;
                }

                flashToast('API key deleted.', 'success');
                window.location.reload();
            } catch (err) {
                hideOverlay();
                confirmDeleteBtn.disabled = false;
                showToast('Network error: ' + err.message, 'danger');
            }
        });
    }
});
