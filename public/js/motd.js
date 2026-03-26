// ── MOTD Editor ──
(function () {
    var input = document.getElementById('motd-input');
    var previewEl = document.getElementById('motd-preview');
    var saveBtn = document.getElementById('motd-save-btn');
    if (!input || !previewEl || !saveBtn) return;

    var serverId = saveBtn.dataset.serverId;
    var csrf = saveBtn.dataset.csrf;

    // The § character used in Minecraft formatting
    var SECTION = '\u00A7';

    // Color code → CSS hex mapping
    var COLORS = {
        '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
        '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
        '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
        'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF'
    };

    // ── Load initial MOTD from embedded JSON ──
    var dataEl = document.getElementById('motd-data');
    if (dataEl) {
        try {
            var data = JSON.parse(dataEl.textContent);
            var rawMotd = data.motd || '';
            // Split on literal \n, replace \u00A7 with §, rejoin with real newline
            var parts = rawMotd.split('\\n');
            input.value = parts
                .map(function (p) { return p.replace(/\\u00A7/gi, SECTION); })
                .join('\n');
        } catch (e) { /* ignore parse errors */ }
    }

    // ── Enforce max 2 lines ──
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            var lines = input.value.split('\n');
            if (lines.length >= 2) e.preventDefault();
        }
    });

    input.addEventListener('input', function () {
        var lines = input.value.split('\n');
        if (lines.length > 2) {
            // Keep only first two lines
            input.value = lines[0] + '\n' + lines.slice(1).join('');
        }
        updatePreview();
    });

    // ── Render MOTD formatting codes to styled HTML ──
    function renderMotdLine(text) {
        var html = '';
        var color = '#AAAAAA'; // default gray
        var bold = false, italic = false, underline = false, strike = false, obfuscated = false;

        var i = 0;
        while (i < text.length) {
            if (text[i] === SECTION && i + 1 < text.length) {
                var code = text[i + 1].toLowerCase();
                if (COLORS[code]) {
                    color = COLORS[code];
                    bold = italic = underline = strike = obfuscated = false;
                } else if (code === 'l') {
                    bold = true;
                } else if (code === 'o') {
                    italic = true;
                } else if (code === 'n') {
                    underline = true;
                } else if (code === 'm') {
                    strike = true;
                } else if (code === 'k') {
                    obfuscated = true;
                } else if (code === 'r') {
                    color = '#AAAAAA';
                    bold = italic = underline = strike = obfuscated = false;
                }
                i += 2;
                continue;
            }

            var styles = 'color:' + color + ';';
            if (bold) styles += 'font-weight:bold;';
            if (italic) styles += 'font-style:italic;';
            var deco = [];
            if (underline) deco.push('underline');
            if (strike) deco.push('line-through');
            if (deco.length) styles += 'text-decoration:' + deco.join(' ') + ';';

            var ch = text[i];
            if (ch === '<') ch = '&lt;';
            else if (ch === '>') ch = '&gt;';
            else if (ch === '&') ch = '&amp;';

            if (obfuscated) {
                html += '<span style="' + styles + '" class="motd-obfuscated">' + ch + '</span>';
            } else {
                html += '<span style="' + styles + '">' + ch + '</span>';
            }
            i++;
        }
        return html || '<span style="color:#555;">&#8203;</span>';
    }

    function updatePreview() {
        var lines = input.value.split('\n');
        var html1 = renderMotdLine(lines[0] || '');
        var html2 = renderMotdLine(lines[1] || '');
        previewEl.innerHTML = html1 + '\n' + html2;
    }

    // ── Insert formatting code at cursor ──
    function insertCode(code) {
        var start = input.selectionStart;
        var end = input.selectionEnd;
        var text = SECTION + code;
        input.value = input.value.substring(0, start) + text + input.value.substring(end);
        input.selectionStart = input.selectionEnd = start + text.length;
        input.focus();
        updatePreview();
    }

    // ── Color buttons ──
    document.querySelectorAll('.motd-color-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            insertCode(btn.dataset.code);
        });
    });

    // ── Style buttons ──
    document.querySelectorAll('.motd-style-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            insertCode(btn.dataset.code);
        });
    });

    // Initial render
    updatePreview();

    // ── Save MOTD (same pattern as Save Retention on backups page) ──
    var motdStatus = document.getElementById('motd-status');

    function showMotdStatus(type, msg) {
        motdStatus.className = 'mt-2 small text-' + type;
        motdStatus.textContent = msg;
    }

    saveBtn.addEventListener('click', async function () {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        motdStatus.textContent = '';

        // Convert § back to \u00A7 for server.properties, join lines with literal \n
        var lines = input.value.split('\n');
        var val1 = (lines[0] || '').replace(new RegExp(SECTION, 'g'), '\\u00A7');
        var val2 = (lines[1] || '').replace(new RegExp(SECTION, 'g'), '\\u00A7');
        var motd = val1 + (val2 ? '\\n' + val2 : '');

        try {
            var res = await fetch('/api/servers/' + serverId + '/motd', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf
                },
                body: JSON.stringify({ motd: motd })
            });

            if (res.ok) {
                saveBtn.textContent = 'Saved!';
                showMotdStatus('success', 'Restart the server for changes to take effect.');
                // Show restart modal if server is running
                var modalEl = document.getElementById('restartModal');
                if (modalEl) {
                    var state = modalEl.dataset.serverState;
                    if (state !== 'stopped' && state !== 'crashed') {
                        new bootstrap.Modal(modalEl).show();
                    }
                }
            } else {
                saveBtn.textContent = 'Error';
                showMotdStatus('danger', 'Failed to save MOTD.');
            }
        } catch {
            saveBtn.textContent = 'Error';
            showMotdStatus('danger', 'Failed to save MOTD.');
        }
        setTimeout(function () {
            saveBtn.textContent = 'Save MOTD';
            saveBtn.disabled = false;
        }, 2000);
    });

    // ── Obfuscated text animation ──
    var obfChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    setInterval(function () {
        document.querySelectorAll('.motd-obfuscated').forEach(function (el) {
            el.textContent = obfChars[Math.floor(Math.random() * obfChars.length)];
        });
    }, 50);
})();
