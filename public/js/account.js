document.addEventListener('DOMContentLoaded', function () {
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
    // API Keys — Listing
    // ═══════════════════════════════════════════
    // Rendered by the view on first load and by buildRow below on every change
    // after that, from the same listing the API returns. Keep the two in step
    // with views/account.ejs.

    var keysTbody = document.getElementById('apikeys-tbody');
    var keysTable = document.getElementById('apikeys-table');
    var keysEmpty = document.getElementById('apikeys-empty');

    function buildKeyRow(key) {
        var tr = document.createElement('tr');
        tr.dataset.keyId = key.id;

        var nameTd = document.createElement('td');
        nameTd.textContent = key.name;
        tr.appendChild(nameTd);

        var prefixTd = document.createElement('td');
        prefixTd.className = 'text-body-secondary small';
        var code = document.createElement('code');
        code.textContent = key.prefix + '\u2026';
        prefixTd.appendChild(code);
        tr.appendChild(prefixTd);

        var createdTd = document.createElement('td');
        createdTd.className = 'text-body-secondary small';
        var created = document.createElement('span');
        created.className = 'format-date';
        created.dataset.iso = key.createdAt;
        created.textContent = formatDate(key.createdAt);
        createdTd.appendChild(created);
        tr.appendChild(createdTd);

        var usedTd = document.createElement('td');
        usedTd.className = 'text-body-secondary small';
        if (key.lastUsedAt) {
            var used = document.createElement('span');
            used.className = 'format-date';
            used.dataset.iso = key.lastUsedAt;
            used.textContent = formatDate(key.lastUsedAt);
            usedTd.appendChild(used);
        } else {
            usedTd.textContent = 'Never';
        }
        tr.appendChild(usedTd);

        var actionsTd = document.createElement('td');
        actionsTd.className = 'text-end';
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-outline-danger btn-sm d-inline-flex align-items-center justify-content-center delete-key-btn';
        del.style.cssText = 'width: 32px; height: 32px; padding: 0;';
        del.title = 'Delete';
        del.dataset.keyId = key.id;
        del.dataset.keyName = key.name;
        del.dataset.keyPrefix = key.prefix;
        del.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">delete</span>';
        actionsTd.appendChild(del);
        tr.appendChild(actionsTd);
        return tr;
    }

    function renderKeys(keys) {
        if (!keysTbody) return;
        keysTbody.innerHTML = '';
        keys.forEach(function (key) { keysTbody.appendChild(buildKeyRow(key)); });
        if (keysEmpty) keysEmpty.classList.toggle('d-none', keys.length > 0);
        if (keysTable) keysTable.classList.toggle('d-none', keys.length === 0);
    }

    // Refetch and redraw. Sequenced so a slow response can never paint over a
    // newer one.
    var keysRefreshSeq = 0;
    async function refreshKeys() {
        if (!keysTbody) return;
        var seq = ++keysRefreshSeq;
        var res = await apiFetch('/api/v1/account/apikeys');
        if (seq !== keysRefreshSeq) return;
        if (!res.ok || !res.data) {
            showToast((res.data && (res.data.message || res.data.error)) || 'Could not refresh the API key list.', 'danger');
            return;
        }
        renderKeys(res.data.keys || []);
    }

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
                var res = await apiFetch('/api/v1/account/apikeys', {
                    method: 'POST',
                    body: { name: name }
                });
                var data = res.data || {};
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
                // Listed behind the modal straight away, so nothing changes
                // underfoot when it closes.
                refreshKeys();
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

    // "I've saved it" closes the show-key modal; the table already has the
    // new key by then.
    var savedKeyBtn = document.getElementById('saved-key-btn');
    if (savedKeyBtn) {
        savedKeyBtn.addEventListener('click', function () {
            showKeyModal.hide();
        });
    }

    // ═══════════════════════════════════════════
    // API Keys — Delete
    // ═══════════════════════════════════════════

    var pendingDeleteId = null;

    // Bound once, on the table, so rows drawn later work too.
    if (keysTbody) {
        keysTbody.addEventListener('click', function (e) {
            var btn = e.target.closest('.delete-key-btn');
            if (!btn) return;
            pendingDeleteId = btn.getAttribute('data-key-id');
            document.getElementById('deleteKeyName').textContent = btn.getAttribute('data-key-name') || '';
            document.getElementById('deleteKeyPrefix').textContent = btn.getAttribute('data-key-prefix') || '';
            deleteKeyModal.show();
        });
    }

    var confirmDeleteBtn = document.getElementById('confirm-delete-key-btn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', async function () {
            if (!pendingDeleteId) return;

            confirmDeleteBtn.disabled = true;
            deleteKeyModal.hide();
            showOverlay('Deleting key...', 'Please wait while the key is removed.');

            try {
                var res = await apiFetch('/api/v1/account/apikeys/' + encodeURIComponent(pendingDeleteId), {
                    method: 'DELETE'
                });

                if (!res.ok && res.status !== 204) {
                    var data = res.data || {};
                    hideOverlay();
                    confirmDeleteBtn.disabled = false;
                    showToast(data.message || data.error || 'Failed to delete key.', 'danger');
                    return;
                }

                await refreshKeys();
                hideOverlay();
                confirmDeleteBtn.disabled = false;
                showToast('API key deleted.', 'success');
            } catch (err) {
                hideOverlay();
                confirmDeleteBtn.disabled = false;
                showToast('Network error: ' + err.message, 'danger');
            }
        });
    }
});
