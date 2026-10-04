# Browser regression check

With Node.js and Playwright installed, run `node tests/notebooks-browser.cjs`.
Set `INFO1_TEST_CHROME` to use an existing Chromium executable.
Python 3 serves the app on local port 8769 during the test.

The suite uses two independent browser contexts and a deterministic Supabase
transport, including the SDK's single-subscription constraint. It covers screen
navigation, live in-progress strokes, simultaneous drawing, received-state
persistence, page creation, failed sends, concurrent queue appends, storage quota
errors, mutation observer loops, and an offline PWA reload. It never authenticates
or changes production user data. It does not replace a real tablet/stylus or live
Supabase end-to-end check.
