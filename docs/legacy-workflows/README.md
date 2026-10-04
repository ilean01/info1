# Archived one-time installers

These historical installers contained invalid YAML because inline Python strings
escaped the YAML block indentation. GitHub reported validation failures on pushes.
Their changes are already in `device-sync.js` and `cloud-sync.js`; the maintained
release workflow uses `scripts/mobile-sync-v4.py`.

The original installers are retained here for reference, outside the executable
workflow directory, so they cannot reapply obsolete source replacements. The
release-marker workflow and GitHub Pages deployment remain active.
