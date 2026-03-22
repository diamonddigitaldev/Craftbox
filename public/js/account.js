document.addEventListener('DOMContentLoaded', function () {
    var confirmSaveBtn = document.getElementById('confirmSaveBtn');
    var saveBtn = document.getElementById('saveBtn');
    var form = document.getElementById('accountForm');
    var currentPwField = document.getElementById('currentPassword');
    var newUsernameField = document.getElementById('newUsername');
    var newPasswordField = document.getElementById('newPassword');
    var confirmPwField = document.getElementById('confirmNewPassword');

    // Enable the save button only when current password is filled
    // AND at least one change (username or password) is provided
    function checkForm() {
        var hasCurrent = currentPwField.value.length > 0;
        var hasChange = newUsernameField.value.trim().length > 0 || newPasswordField.value.length > 0;
        saveBtn.disabled = !(hasCurrent && hasChange);
    }

    form.addEventListener('input', checkForm);
    form.addEventListener('change', checkForm);
    checkForm();

    // Submit the form from the modal confirmation button
    confirmSaveBtn.addEventListener('click', function () {
        bootstrap.Modal.getInstance(document.getElementById('confirmModal')).hide();
        form.method = 'POST';
        form.action = '/account';
        showOverlay('Saving account...', 'Please wait while your changes are applied.');
        form.submit();
    });

    // Enter key triggers save button
    form.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (!saveBtn.disabled) saveBtn.click();
        }
    });

    // Final validation before showing the modal
    saveBtn.addEventListener('click', function (e) {
        var newPassword = newPasswordField.value;
        var confirmPw = confirmPwField.value;

        if (newPassword && newPassword !== confirmPw) {
            e.stopPropagation();
            e.preventDefault();
            confirmPwField.focus();
            return;
        }
    });
});
