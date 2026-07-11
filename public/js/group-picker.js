// Shared "search or create" group picker: filters a list of existing group
// names as the user types. Used inside the Assign Group modal (groups.js) and
// inline on the create/edit forms (auto-init below).
function initGroupPicker(inputEl, listEl, options) {
    options = options || {};
    var getNames = options.getNames || function () { return []; };

    function render() {
        var query = inputEl.value.trim().toLowerCase();
        var names = getNames().filter(function (name) {
            return !query || name.toLowerCase().indexOf(query) !== -1;
        });

        listEl.innerHTML = '';
        names.forEach(function (name) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'list-group-item list-group-item-action d-flex align-items-center gap-2';
            var icon = document.createElement('span');
            icon.className = 'material-icons-outlined';
            icon.style.fontSize = '1rem';
            icon.textContent = 'folder';
            item.appendChild(icon);
            item.appendChild(document.createTextNode(name));
            // mousedown preventDefault keeps the input focused so an inline
            // picker's blur handler can't hide the list before the click lands.
            item.addEventListener('mousedown', function (e) { e.preventDefault(); });
            item.addEventListener('click', function () {
                inputEl.value = name;
                if (options.onPick) options.onPick(name);
                render();
            });
            listEl.appendChild(item);
        });

        var focused = document.activeElement === inputEl;
        var visible = names.length > 0 && (!options.hideOnBlur || focused);
        listEl.classList.toggle('d-none', !visible);
    }

    inputEl.addEventListener('input', render);
    if (options.hideOnBlur) {
        inputEl.addEventListener('focus', render);
        inputEl.addEventListener('blur', function () {
            setTimeout(function () { listEl.classList.add('d-none'); }, 100);
        });
    } else {
        render();
    }
    return { render: render };
}

// Auto-init inline pickers (create/edit form Group inputs)
document.querySelectorAll('input[data-group-picker]').forEach(function (inputEl) {
    var listEl = inputEl.parentElement.querySelector('.group-picker-list');
    if (!listEl) return;
    var names = [];
    try { names = JSON.parse(inputEl.dataset.groups || '[]'); } catch (_) { }
    initGroupPicker(inputEl, listEl, {
        getNames: function () { return names; },
        hideOnBlur: true,
        onPick: function () {
            // Choosing a group closes the dropdown and drops focus off the field.
            listEl.classList.add('d-none');
            inputEl.blur();
        }
    });
});
