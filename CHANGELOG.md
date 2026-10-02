# Changelog

## 1.0.2

- Fixed: comparing with the server version no longer shows Croatian and other non-ASCII letters as mojibake for a file that TFVC still records as windows-1250 but that was saved as UTF-8. Before, every line with such a letter showed as changed. Annotate, History and shelveset views had the same fault and are fixed too.

## 1.0.1

- Fixed: automatic checkout now happens on the first keystroke. A single keystroke into a clean file used to do nothing, and only a second one checked the file out.
- Fixed: Undo now discards the unsaved edits in an open editor for a file inside the opened folder. Before, the edit stayed on screen while the file was read-only again with no pending change.

## 1.0.0

First public release.

- Pending changes in the Source Control panel: Included and Excluded changes, conflicts, a check-in comment and a Check In button that always asks first, Undo, Compare, and change bars in the editor gutter.
- Automatic checkout on the first keystroke (or on save, or never), and badges in the Explorer for every file's TFVC state, including files that were made writable without being checked out.
- Check Out, Undo, Add, Get Latest Version, Compare with Latest Version, and rename, move and delete from the Explorer.
- History and Annotate.
- Source Control Explorer, Get Specific Version, and workspace and mapping management.
- Shelvesets: shelve, find, view, compare, unshelve and delete.
- Conflict resolution.
- Runs on Windows with Visual Studio's tf.exe, and on Linux with the same tf.exe under Wine.
