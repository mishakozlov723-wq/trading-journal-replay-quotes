# Replay quotes updater

This repository contains ONLY public Dukascopy BID candles and the updater. It has no journal accounts, trades, user data, or journal UI.

The schedule is 03:23 UTC / 06:23 Moscow every day. GitHub may delay or skip a scheduled run under load; `workflow_dispatch` supports a manual retry. Each successful run catches up from the last known candle rather than assuming yesterday was downloaded.

Before use:

1. Create and seed a separate Firebase Hosting site in project `retocker`. Never use the main journal site.
2. Add repository variable `FIREBASE_QUOTES_SITE` with that new site ID.
3. Add repository secret `FIREBASE_SERVICE_ACCOUNT_JSON` with a dedicated deployment service account JSON. For this live static-only deployment use Firebase Hosting Admin and API Keys Viewer; Auth Admin (preview-domain changes) and Cloud Run Viewer (server rewrites) are not needed here. Hosting Admin applies to the project's Hosting resources, including the main site, even though this workflow explicitly targets only the quotes site. Keep the key out of the repository and chat. Firebase's official setup guidance: https://github.com/FirebaseExtended/action-hosting-deploy/blob/main/docs/service-account.md
4. Put this folder at the ROOT of a private GitHub repository, including `.github`, `package-lock.json`, and the initial `public/replay-data` files. Select its default branch when running the action.
5. Run `Update replay quotes` manually and check its result before relying on the schedule.

`npm ci` then `npm test` runs the updater tests. `npm run update` without `REPLAY_SOURCE_URL` updates local seed files; with `REPLAY_SOURCE_URL=https://YOUR-SITE.web.app/replay-data/` it restores the published snapshot before updating. The CI workflow always uses the published snapshot, so stale Git files cannot roll back newer candles.

The updater preserves the original binary format, H1 history and yearly M5 files, requests a 7-day overlap, and downloads only completed UTC days. A missing known overlapping candle, failed network request, invalid new OHLC, corrupted source file or checksum mismatch stops the entire update. Existing history is never replaced with an empty response. No new candles/corrections means no Firebase release. The first run also adds a SHA-256 manifest.

The archive contains legacy OHLC inconsistencies of up to 2 ticks in EURUSD/GBPUSD for October 2024. These exact old values are retained; new provider candles have strict OHLC validation.

The starting snapshot is approximately 82 MiB. This simple workflow downloads the complete published snapshot once a day (roughly 2.5 GiB per month). This traffic and retained releases share the Firebase Hosting quota with the journal. Monitor Usage and set a modest release retention limit ONLY for the quotes site. Do not assume unlimited free resources. Firebase quota reference: https://firebase.google.com/docs/hosting/usage-quotas-pricing

No production Firebase deployment or GitHub repository has been created while preparing this package. Fetching samples from October 2024 worked for all four assets; a sample request for October 1, 2026 returned zero rows. Current provider availability and a real scheduled deployment remain unverified.
