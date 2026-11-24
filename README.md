# ETCH CRM

An Arabic, right-to-left CRM for tracking companies, contacts, sales opportunities, targets, and follow-up tasks. The demo includes fictional sales records.

## Build and preview

With Node.js installed, run:

```sh
node build-live.mjs
npx wrangler dev dist/server/index.js
```

Open the local URL printed by Wrangler and visit /demo. This route works without a database or login.

## Shared workspace

For live records, use a Worker-compatible runtime with a D1 database bound as DB and apply the numbered SQL migrations in drizzle in order. Put the worker behind an identity-aware gateway that strips client-supplied oai-authenticated-user-id and oai-authenticated-user-email headers and sets those headers from a verified login. Restrict direct access to the worker before enabling live access.

Set ETCH_OWNER_EMAIL for the editor and ETCH_LIVE_VIEWER_EMAILS for optional comma-separated viewers. Set ETCH_PUBLIC_ORIGIN to your deployment origin. Mobile push also requires your own VAPID keys and scheduler configuration. Keep deployment secrets outside the repository.
