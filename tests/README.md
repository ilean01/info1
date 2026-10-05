# Regression checks

With Node.js, Playwright and Python 3 installed:

```
node tests/storage-merge.cjs
node tests/cloud-races.cjs
node tests/pencil-width.cjs
node tests/notebooks-browser.cjs
```

Set `INFO1_TEST_CHROME` to use an existing Chromium executable.
The suites serve local ports 8770, 8771 and 8769 respectively.

Coverage: large-state IndexedDB migration, atomic storage failure and retry,
crash recovery journal, stale snapshots, deletion/redo, cloud revision races,
edits during upload/download, 52 navigation combinations, live ink between two
independent browser contexts, concurrent strokes, received-state persistence,
page creation, offline queue replay, persistent laser, iPad-size fullscreen exit,
offline PWA boot and previously opened PDF access.

Cloud tests use deterministic transports. They never authenticate or alter
production user data. Chromium viewport tests do not replace physical Safari,
Apple Pencil, iPadOS suspension or live Supabase end-to-end checks.
