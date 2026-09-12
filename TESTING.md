# Craftbox 1.2.0-beta.12 — manual browser test checklist

Covers what beta.12 changes and nothing else. beta.11 was a single-fix build
on top of beta.10's closed checklist, so everything up to and including that
build is already signed off.

Four areas changed:

- **A. Lists redraw in place.** Files, plugins/mods, backups, templates, API
  keys and the event log no longer reload the page after a change. Each
  refetches its own listing and rebuilds the rows where they stand, and other
  open tabs on the same listing are told over the WebSocket and refetch too.
  Scheduled backups now report their outcome the same way manual ones do.
- **B. Search filters persist.** Whatever is in a list's search box (and the
  mods environment filter) is still applied after an upload, delete, rename,
  install or a change made from another tab.
- **C. Closest-match search.** The files, plugins/mods, version-picker and
  group-picker search boxes match on closeness, not just substring: typos,
  abbreviations, initials and words in the wrong order all find things, and the
  two tables order their hits best-first.
- **D. Dependencies.** content-disposition 1.1 → 2.0, multer 2.2 → 2.3,
  express-rate-limit 8.6 → 8.7. Only the first changes any behaviour a browser
  can see (the download filename header is worded slightly differently).

Setup:

- A fresh container or environment, empty data directory.
- Servers to create during the pass: one **Paper** (plugins) and one
  **Fabric** (mods, so the environment column exists). Any recent version.
- Internet access — one check installs a real plugin from Modrinth.
- **Two browser tabs** on the same page for the cross-tab checks (a second
  window or a second browser is fine too; it just needs the same login).
- A handful of throwaway files to upload, including at least one `.jar`
  (any jar; it only has to start with the zip signature) and one text file.

Every check below is about the page **not** reloading. If you are unsure
whether it did, open DevTools → Console and type `window.x = 1` before the
action; if `window.x` is still `1` afterwards, it did not.

---

## A1. Files page — redraw in place

On the Paper server, **Files** tab, server stopped.

- [x] Click **New Folder**, name it `Test Folder`, Create. The modal closes,
      a success toast appears, and the folder row appears in the table
      without the page reloading. Folders are still listed first.
- [x] Click **New Text File**, accept `notes.txt` (the caret sits before
      `.txt`), Create. Same: toast, new row, no reload. The new row has an
      Edit button (it is a text file) and a Download button.
- [x] Pick two files with **Choose files** and click **Upload**. The overlay
      shows, then clears; the rows appear; the toast reads "2 files
      uploaded."; the file picker is emptied and Upload is disabled again.
- [x] Upload one of the same files again → toast reads "1 file uploaded, 1
      replaced." and the row's size/modified update rather than duplicating.
- [x] Drag-drop a file onto the page → same behaviour as the picker.
- [x] Click the **Rename** button on `notes.txt`, change it to `renamed.txt`,
      Enter. The modal closes, the row's name, Edit link and Download link all
      point at the new name, no reload.
- [x] Rename it to the same name → the modal just closes, nothing changes.
- [x] Click **Delete** on the folder. The modal says "Delete Folder" and
      warns about contents. Confirm → row gone, toast "Folder deleted.", no
      reload.
- [x] Delete every file in a sub-folder until it is empty → the "This
      directory is empty." row appears in place and the search bar hides.
- [x] Create a file in that empty folder → the empty row hides and the search
      bar comes back.
- [x] **Start the server.** The Rename/Delete/Download buttons on every row
      disable with a tooltip, including rows that were added by the steps
      above (not just the ones the page loaded with). Create a folder while
      running (allowed): its row's buttons come out disabled too.
- [x] **Stop the server.** All of them enable again.
- [x] Open a text file in the editor, change it, Save, then go back to the
      Files tab — this is a real navigation, so a reload is expected here.
      The point of the check is the next one.

## A2. Files page — other tabs

Two tabs, both on the **same directory** of the same server.

- [x] Upload a file in tab 1 → within a second the row appears in tab 2, with
      no toast in tab 2 and no reload.
- [x] Delete it in tab 2 → it disappears from tab 1.
- [x] Tab 1 on the server root, tab 2 inside `plugins/`. Upload to the root
      in tab 1 → tab 2 is untouched (it is a different listing).
- [x] Tab 2 inside a folder, tab 1 on the root. **Delete that folder** in
      tab 1 → tab 2 steps up to the parent directory on its own with a warning
      toast naming the folder that no longer exists.
- [x] Rename that folder instead of deleting it → same: tab 2 steps up.
- [x] Edit and save a text file in the editor in tab 1 while tab 2 shows
      its directory → tab 2's size/modified for that file update.

## A3. Plugins / Mods page — redraw in place

On the Paper server, **Plugins** tab, server stopped, nothing installed yet.

- [x] The page shows "0 plugins installed", no Download All / Delete All, no
      search bar, and the "No plugins installed" row.
- [x] Upload three `.jar` files. Rows appear; the heading reads "3 plugins
      installed"; Download All, Delete All and the search bar appear — no
      reload.
- [x] Delete one → "2 plugins installed", the Delete All modal (open it) says
      "all **2** plugins".
- [x] Delete all but one → the heading reads "1 plugin installed" (singular).
- [x] **Delete All** → overlay, then the empty state: "0 plugins installed",
      bulk actions and search bar hidden, empty row shown, toast "All plugins
      deleted." — no reload.
- [x] **Browse Modrinth**, install any plugin (Chunky, ViaVersion, …). The
      button flips to "Installed" and — with the modal still open — the table
      behind it already lists the new jar and the heading says "1 plugin
      installed". Close the modal: nothing reloads, the list is as it was.
- [x] Install a plugin that has required dependencies (e.g. one that pulls
      in a library) → every installed file appears in the table.

On the Fabric server, **Mods** tab:

- [x] Upload two `.jar` mods. The Environment dropdown on each is "Client and
      Server".
- [x] Change one to "Client Only" → toast "Mod environment updated.", the
      dropdown keeps its value.
- [x] Set the **Filter** to "Client Only" → only that mod shows. Upload
      another jar → the new mod (which is Client and Server) stays hidden by
      the filter, the filtered mod stays visible, no reload.
- [x] Filter back to "All Environments"; every row shows and the changed mod
      still reads "Client Only" (it survived the redraw).
- [x] **Start the server**: the environment dropdowns and Delete buttons
      disable, including on rows added since the page loaded. Stop it: they
      enable.

## A4. Plugins page — other tabs

- [x] Two tabs on the Plugins tab. Upload in one → appears in the other.
      Delete in the other → disappears from the first.
- [x] Install from Modrinth in tab 1 → tab 2's table gains the jar.

## A5. Backups page

On either server, **Backups** tab.

- [x] With no backups, the card shows "Backups (0)" and the empty state.
- [x] **Create Backup** (server stopped) → overlay, then toast "Backup
      created successfully.", the row appears, the header reads "Backups
      (1)" — with no space inside the brackets — and the empty state is
      gone. No reload.
- [x] Create one with the server **running** ("Stop & Backup") → same
      outcome, plus the server restarts if you left the box ticked.
- [x] **Delete** a backup → overlay, row gone, count down by one, toast. No
      reload. Delete the last one → the empty state returns.
- [x] **Restore** a backup (untick "Start server after restore") → overlay,
      toast "Backup restored successfully.", list unchanged, no reload.
- [x] Set **Retention** to keep 1 backup, then create two backups. After the
      second completes, the list shows exactly one (the older one was pruned
      and the list caught it) without a reload.
- [x] Open the Restore modal with the server **running** → it warns the
      server will be stopped. Stop the server from another tab while the
      modal is open → the warning disappears live.
- [x] Enable **Scheduled backups** with a 1-hour interval — you do not have
      to wait for it. Instead, from another tab, save the schedule again to
      confirm nothing on this page breaks, then disable it.
- [x] Two tabs on the Backups tab: create a backup in tab 1 → the row
      appears in tab 2 **without** a "created successfully" toast there (the
      toast is only for the tab that started it). Delete in tab 2 → gone in
      tab 1.
- [x] Reload the page **while** a backup is running (start a large one and
      hit F5): the overlay comes up on load and is released, with the toast,
      when the backup finishes.

## A6. Templates, API keys, event log

- [x] **Templates** (`/templates`): with two saved, delete one → row goes,
      toast, no reload. Delete the other → the "No templates yet" empty
      state appears in place, no reload.
- [x] **Account → API Keys**: with none, the empty state shows. New Key →
      the "copy it now" modal opens and the key is **already in the table
      behind it**. "I've saved it" closes the modal with no reload. Delete
      the key → overlay, row gone, empty state back, no reload.
- [x] **Events**: Clear Events → overlay, modal closes, empty state shows,
      count badge 0, toast "Events cleared.", no reload. Start the server →
      new rows appear live as before.

## B. Search filters persist

- [x] Files: type `world` in the search box, then upload a file whose name
      does not contain it → the list redraws and the new file is **not**
      shown; the search box still says `world`.
- [x] Files: with a search active, delete the only matching file → "No files
      match your search." appears (not the "directory is empty" row, since
      the folder is not empty).
- [x] Clear the search → everything shows, in the original folders-first
      order.
- [x] Plugins: search + environment filter both set; delete a mod, upload a
      mod, change an environment → both filters are still applied after each.
- [x] Any list: with a search active, make a change from **another tab** →
      the redraw keeps this tab's search.

## C. Closest-match search

Files page, with a server that has the usual `world`, `world_nether`,
`world_the_end`, `server.properties`, `eula.txt`, `logs`, `plugins`:

- [x] `world` → world, world_nether, world_the_end, in that order (exact
      first, then prefixes); nothing else.
- [x] `srv prop` → server.properties (two tokens, both matched).
- [x] `sp` → server.properties and server-icon.png (initials).
- [x] `proprties` → server.properties (one typo).
- [x] `eula` → eula.txt; `zzz` → the "No files match your search." row.
- [x] Type a query, then clear it → the rows go back to folders-first,
      alphabetical.

Plugins page with `EssentialsX.jar`, `WorldEdit.jar`, `LuckPerms.jar` (or
whatever three you have — substitute):

- [x] `we` → WorldEdit (initials of camelCase words).
- [x] `essentails` → EssentialsX (typo).
- [x] `edit world` → WorldEdit (tokens in either order).
- [x] `lp` → LuckPerms.

Version picker (Create Server → Browse versions, Vanilla):

- [x] `1214` → 1.21.4 (digits in order); `1.21.1` → 1.21.11, 1.21.10, 1.21.1
      and **not** 1.21.4 (no typo matching on versions).
- [x] `snap` (with the channel on "All") → only snapshot ids; results stay
      newest-first.

Group picker (Create Server → Group, with a couple of groups existing):

- [x] Typing the first letters of each word of a group name (`sw` for
      "Survival Worlds") offers it; a typo (`survivl`) still offers it; the
      list keeps its alphabetical order.

## D. Dependencies

- [x] Download a single file from the Files tab → the browser saves it under
      its own name.
- [x] Download a file whose name has a space and a non-ASCII character in it
      (rename one to `héllo wörld.txt` first) → the browser saves it with
      that exact name.
- [x] Download a backup and a server export (`.cbx`) → correct names.
- [x] Five failed logins in a row → the sixth is rate limited with the usual
      "too many attempts" response (express-rate-limit).
- [x] Upload a file through the Files tab that is larger than 100 MB (goes
      through the chunked path) and one that is small (plain multipart) →
      both land (multer).
