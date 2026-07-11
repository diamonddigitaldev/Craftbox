// Server group interactions: the Assign Group modal (dashboard + group pages),
// live dashboard/tile updates, and group color editing on group pages.
(function () {
    var modalEl = document.getElementById('addGroupModal');
    var grid = document.getElementById('server-grid');
    var groupPageHeader = document.getElementById('group-page-header');
    var currentPageGroup = groupPageHeader ? groupPageHeader.dataset.groupName : null;

    var DEFAULT_GROUP_COLOR = '#4caf50';

    // Same rule the server enforces (1-50 chars, letters/numbers/spaces/-/_).
    var GROUP_NAME_RE = /^[a-zA-Z0-9 _\-]+$/;
    function isValidGroupName(name) {
        var t = String(name || '').trim();
        return t.length >= 1 && t.length <= 50 && GROUP_NAME_RE.test(t);
    }

    // ── Assign Group modal ──
    if (modalEl && grid) {
        var input = document.getElementById('add-group-input');
        var listEl = document.getElementById('add-group-list');
        var confirmBtn = document.getElementById('add-group-confirm');
        var removeBtn = document.getElementById('add-group-remove');

        var groupNames = [];
        try {
            groupNames = JSON.parse(modalEl.dataset.groups || '[]');
        } catch (_) { }

        var activeCard = null;
        var busy = false;

        function updateAddConfirm() {
            confirmBtn.disabled = busy || !isValidGroupName(input.value);
        }

        var picker = initGroupPicker(input, listEl, {
            hideOnBlur: true,
            getNames: function () {
                var current = activeCard ? activeCard.dataset.group : '';
                return groupNames.filter(function (n) { return n !== current; });
            },
            onPick: function (name) { submitGroup(name); }
        });

        grid.addEventListener('click', function (e) {
            var btn = e.target.closest('.add-group-btn');
            if (!btn) return;
            activeCard = btn.closest('.server-card');
            input.value = '';
            removeBtn.classList.toggle('d-none', !activeCard.dataset.group);
            updateAddConfirm();
            picker.render();
            new bootstrap.Modal(modalEl).show();
        });

        // Only auto-focus the name field for ungrouped servers. For a server
        // that already has a group, we don't want the cursor sitting in the box.
        modalEl.addEventListener('shown.bs.modal', function () {
            if (activeCard && !activeCard.dataset.group) input.focus();
        });
        input.addEventListener('input', updateAddConfirm);

        async function submitGroup(groupName) {
            if (busy || !activeCard) return;
            busy = true;
            confirmBtn.disabled = true;

            var card = activeCard;
            var serverId = card.dataset.serverId;
            var res = await apiFetch('/api/v1/servers/' + serverId + '/group', {
                method: 'POST',
                body: { group: String(groupName || '') }
            });

            busy = false;
            updateAddConfirm();
            if (!res.ok) {
                showToast((res.data && res.data.error) || 'Failed to update group.', 'danger');
                return;
            }

            var newGroup = res.data.group; // string, or null when removed
            bootstrap.Modal.getInstance(modalEl)?.hide();

            var serverName = card.dataset.serverName || 'Server';
            var message = newGroup
                ? '"' + serverName + '" added to group "' + newGroup + '".'
                : '"' + serverName + '" removed from its group.';

            if (newGroup && groupNames.indexOf(newGroup) === -1) groupNames.push(newGroup);
            var redirecting = applyLiveUpdate(card, newGroup, res.data.color);
            if (redirecting) {
                // The empty-group redirect to /dashboard would wipe a regular toast
                flashToast(message, 'success');
            } else {
                showToast(message, 'success');
            }
            activeCard = null;
        }

        confirmBtn.addEventListener('click', function () {
            var name = input.value.trim();
            if (!name) return;
            submitGroup(name);
        });

        removeBtn.addEventListener('click', function () { submitGroup(''); });

        // Submit on Enter (unless a picker list item is focused — let it click)
        modalEl.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            if (e.target.closest('.group-picker-list')) return;
            e.preventDefault();
            var name = input.value.trim();
            if (name) submitGroup(name);
        });
    }

    // Returns true when the update triggers a navigation, so callers know a
    // regular toast would be wiped and must use flashToast instead.
    function applyLiveUpdate(card, newGroup, color) {
        var col = card.closest('[class*="col-"]');
        card.dataset.group = newGroup || '';

        if (currentPageGroup) {
            // Group page: the server left this group (moved or removed)
            if (newGroup !== currentPageGroup) {
                col?.remove();
                var remaining = grid.querySelectorAll('.server-card').length;
                var countEl = document.getElementById('group-page-count');
                if (countEl) countEl.textContent = remaining;
                if (remaining === 0) {
                    window.location.href = '/dashboard';
                    return true;
                }
            }
            return false;
        }

        // Dashboard: only ungrouped servers render as cards, so a move into a
        // group removes the card and bumps (or creates) the group's tile.
        if (newGroup) {
            col?.remove();
            bumpTile(newGroup, color);
        }
        return false;
    }

    function bumpTile(name, color) {
        var tilesRow = document.getElementById('group-tiles');
        if (!tilesRow) return;

        var tile = tilesRow.querySelector('[data-group-name="' + name + '"]');
        if (tile) {
            var countEl = tile.querySelector('.group-tile-count');
            var count = (parseInt(countEl?.textContent, 10) || 0) + 1;
            if (countEl) countEl.textContent = count;
            var small = countEl?.parentElement;
            if (small) {
                small.innerHTML = '';
                small.appendChild(countEl);
                small.appendChild(document.createTextNode(' server' + (count === 1 ? '' : 's')));
            }
            return;
        }

        var template = document.getElementById('group-tile-template');
        if (!template) return;
        var clone = template.content.firstElementChild.cloneNode(true);
        clone.dataset.groupName = name;
        clone.querySelector('a').href = '/dashboard/groups/' + encodeURIComponent(name);
        clone.querySelector('.group-tile-name').textContent = name;
        clone.querySelector('.group-tile-count').textContent = '1';
        clone.querySelector('.group-tile-noun').textContent = 'server';
        clone.querySelector('.group-tile').style.setProperty('--group-color', color || DEFAULT_GROUP_COLOR);

        // Keep tiles alphabetical (case-insensitive), matching the server render
        var siblings = Array.from(tilesRow.children);
        var before = siblings.find(function (el) {
            return name.localeCompare(el.dataset.groupName || '', undefined, { sensitivity: 'base' }) < 0;
        });
        tilesRow.insertBefore(clone, before || null);
        tilesRow.classList.remove('d-none');
    }

    // ── Group edit (rename + color) — group pages only ──
    var editBtn = document.getElementById('group-edit-btn');
    var editModalEl = document.getElementById('groupEditModal');
    if (editBtn && editModalEl && currentPageGroup) {
        var renameInput = document.getElementById('group-rename-input');
        var colorInput = document.getElementById('group-color-input');
        var colorHex = document.getElementById('group-color-hex');
        var editConfirm = document.getElementById('group-edit-confirm');
        var savingEdit = false;

        function updateEditConfirm() {
            editConfirm.disabled = savingEdit || !isValidGroupName(renameInput.value);
        }

        editBtn.addEventListener('click', function () {
            renameInput.value = currentPageGroup;
            colorInput.value = colorInput.value || '#4caf50';
            colorHex.textContent = colorInput.value.toUpperCase();
            updateEditConfirm();
            new bootstrap.Modal(editModalEl).show();
        });

        editModalEl.addEventListener('shown.bs.modal', function () {
            renameInput.focus();
            renameInput.select();
        });

        renameInput.addEventListener('input', updateEditConfirm);

        colorInput.addEventListener('input', function () {
            colorHex.textContent = colorInput.value.toUpperCase();
        });

        async function saveGroupEdit() {
            if (savingEdit) return;

            var newName = renameInput.value.trim();
            if (!isValidGroupName(newName)) {
                showToast('Enter a valid group name (1-50 characters).', 'danger');
                return;
            }

            savingEdit = true;
            editConfirm.disabled = true;

            var groupName = currentPageGroup;
            var renamed = newName !== groupName;

            if (renamed) {
                var renameRes = await apiFetch('/api/v1/groups/' + encodeURIComponent(groupName) + '/rename', {
                    method: 'POST',
                    body: { name: newName }
                });
                if (!renameRes.ok) {
                    showToast((renameRes.data && renameRes.data.error) || 'Failed to rename group.', 'danger');
                    savingEdit = false;
                    updateEditConfirm();
                    return;
                }
                groupName = newName;
            }

            var colorRes = await apiFetch('/api/v1/groups/' + encodeURIComponent(groupName), {
                method: 'POST',
                body: { color: colorInput.value }
            });

            savingEdit = false;
            updateEditConfirm();

            if (!colorRes.ok) {
                showToast((colorRes.data && colorRes.data.error) || 'Failed to update group color.', 'danger');
                return;
            }

            bootstrap.Modal.getInstance(editModalEl)?.hide();

            if (renamed) {
                // The URL is keyed by group name — reload onto the new one so the
                // title, header, and history all reflect it correctly.
                flashToast('Group renamed to "' + newName + '".', 'success');
                window.location.href = '/dashboard/groups/' + encodeURIComponent(newName);
                return;
            }

            document.querySelectorAll('.group-page-icon').forEach(function (el) {
                el.style.color = colorRes.data.color;
            });
            showToast('Group updated.', 'success');
        }

        editConfirm.addEventListener('click', saveGroupEdit);
        editModalEl.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            saveGroupEdit();
        });
    }
})();
