(function () {
    'use strict';

    var serverId = document.getElementById('server-id')?.value || '';
    var csrf = document.getElementById('csrf-token')?.value || '';
    var serverStopped = document.getElementById('server-stopped')?.value === 'true';

    // Remember current browse URL so tabs/back button restore position
    if (window.location.pathname.includes('/plugins/browse')) {
        sessionStorage.setItem('libraryUrl:' + serverId, window.location.href);
        if (!window.location.pathname.includes('/project/')) {
            sessionStorage.setItem('libraryListUrl:' + serverId, window.location.href);
        }
    }

    // ── DOM references ──

    var versionSelect = document.getElementById('version-select');
    var installBtn = document.getElementById('install-btn');
    var fileInfo = document.getElementById('selected-file-info');
    var installedBadge = document.getElementById('installed-badge');
    var projectName = installBtn ? installBtn.dataset.projectName : '';

    // ── Installed file tracking ──

    // Collect all known filenames for this project (to remove old versions on install)
    function getAllProjectFileNames() {
        var names = [];
        if (versionSelect) {
            for (var i = 0; i < versionSelect.options.length; i++) {
                var fn = versionSelect.options[i].dataset.fileName;
                if (fn) names.push(fn);
            }
        }
        return names;
    }

    function isFileInstalled(opt) {
        return opt && opt.dataset.installed === 'true';
    }

    function updateInstallUI() {
        if (!versionSelect || !installBtn) return;
        var opt = versionSelect.options[versionSelect.selectedIndex];
        var installed = isFileInstalled(opt);

        installBtn.dataset.fileUrl = opt.dataset.fileUrl;
        installBtn.dataset.fileName = opt.dataset.fileName;

        if (fileInfo) {
            fileInfo.textContent = opt.dataset.fileName + ' (' + opt.dataset.fileSize + ')';
        }

        // Update button text
        installBtn.innerHTML =
            '<span class="material-icons-outlined" style="font-size: 1.1rem;">download</span> ' +
            (installed ? 'Reinstall' : 'Install') + ' ' + escapeHtml(projectName);

        // Toggle installed badge
        if (installedBadge) {
            installedBadge.style.display = installed ? '' : 'none';
        } else if (installed && fileInfo) {
            installedBadge = document.createElement('div');
            installedBadge.className = 'd-flex align-items-center justify-content-center gap-1 text-success mb-2';
            installedBadge.id = 'installed-badge';
            installedBadge.innerHTML =
                '<span class="material-icons-outlined" style="font-size: 1.1rem;">check_circle</span>' +
                '<small><strong>Installed</strong></small>';
            fileInfo.parentElement.after(installedBadge);
        }
    }

    function markFileInstalled(fileName) {
        if (!versionSelect) return;
        var lower = fileName.toLowerCase();

        // Update every dropdown option
        for (var i = 0; i < versionSelect.options.length; i++) {
            var opt = versionSelect.options[i];
            var optFile = (opt.dataset.fileName || '').toLowerCase();
            // Strip any existing (Installed) text first
            var cleanText = opt.textContent.replace(/\s*\(Installed\)\s*$/, '').trim();
            if (optFile === lower) {
                opt.dataset.installed = 'true';
                opt.textContent = cleanText + ' (Installed)';
            } else {
                opt.dataset.installed = 'false';
                opt.textContent = cleanText;
            }
        }

        // Update the install button / badge for current selection
        updateInstallUI();

        // Update version history table badges
        document.querySelectorAll('table tr').forEach(function (row) {
            var btn = row.querySelector('.version-install-btn, .btn-outline-success');
            if (!btn) return;
            var nameCell = row.querySelector('td:first-child .d-flex');
            if (!nameCell) return;
            var btnFile = (btn.dataset.fileName || '').toLowerCase();
            var badge = nameCell.querySelector('.badge.bg-success');
            if (btnFile === lower) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'badge bg-success d-flex align-items-center gap-1';
                    badge.style.fontSize = '0.7rem';
                    badge.innerHTML =
                        '<span class="material-icons-outlined" style="font-size: 0.75rem;">check_circle</span> Installed';
                    nameCell.appendChild(badge);
                }
            } else if (badge) {
                badge.remove();
            }
        });
    }

    // ── Install action ──

    async function installFile(fileUrl, fileName, pName) {
        if (!serverStopped) {
            showToast('Stop the server before installing.', 'warning');
            return;
        }
        if (!fileUrl || !fileName) {
            showToast('No downloadable file found for this version.', 'warning');
            return;
        }

        showOverlay('Installing...', 'Downloading <strong>' + escapeHtml(pName || fileName) + '</strong>');

        try {
            var res = await fetch('/servers/' + serverId + '/plugins/browse/api/install', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf
                },
                body: JSON.stringify({ fileUrl: fileUrl, fileName: fileName, otherFiles: getAllProjectFileNames() })
            });
            var data = await res.json();
            if (data.success) {
                showToast('Installed <strong>' + escapeHtml(data.fileName) + '</strong> successfully.', 'success');
                markFileInstalled(data.fileName);
            } else {
                showToast(data.error || 'Install failed.', 'danger');
            }
        } catch (err) {
            showToast('Network error: ' + err.message, 'danger');
        } finally {
            hideOverlay();
        }
    }

    // ── Detail page: wire up version dropdown + install buttons ──

    if (versionSelect && installBtn) {
        versionSelect.addEventListener('change', function () {
            updateInstallUI();
        });

        installBtn.addEventListener('click', function () {
            installFile(installBtn.dataset.fileUrl, installBtn.dataset.fileName, projectName);
        });
    }

    document.querySelectorAll('.version-install-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            installFile(btn.dataset.fileUrl, btn.dataset.fileName, btn.dataset.projectName);
        });
    });

    // ── Detail page: markdown rendering ──

    var descEl = document.getElementById('project-description');
    var bodyRaw = document.getElementById('project-body-raw');

    if (descEl && bodyRaw) {
        try {
            var markdown = JSON.parse(bodyRaw.textContent);
            if (markdown && typeof marked !== 'undefined') {
                var html = marked.parse(markdown);
                if (typeof DOMPurify !== 'undefined') {
                    html = DOMPurify.sanitize(html, {
                        ADD_TAGS: ['iframe'],
                        ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'src']
                    });
                }
                descEl.innerHTML = html;
                descEl.querySelectorAll('a').forEach(function (a) {
                    a.setAttribute('target', '_blank');
                    a.setAttribute('rel', 'noopener');
                });
            } else if (markdown) {
                descEl.innerHTML = '<pre style="white-space: pre-wrap;">' + escapeHtml(markdown) + '</pre>';
            }
        } catch { /* ignore parse errors */ }
    }
})();
