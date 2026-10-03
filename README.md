# Replay quotes updater

Private updater for Trading Journal Replay, connected to Firebase project `retocker` (Spark).

- Journal: https://retocker.web.app
- Quotes: https://retocker-replay-quotes.web.app/replay-data/meta.json
- Repository: https://github.com/mishakozlov723-wq/trading-journal-replay-quotes
- Workflow: Actions → **Update replay quotes**
- Schedule: **03:23 UTC / 06:23 Moscow every day**, processing completed UTC days.

The journal remains a local project. This repository contains only the quote updater, configuration, and tests. Published candles are restored from the quotes site at each run; the 82 MiB starting archive is not committed to GitHub. Journal accounts, trades and UI are not uploaded here.

The dedicated Hosting site, repository variable `FIREBASE_QUOTES_SITE=retocker-replay-quotes`, and `FIREBASE_SERVICE_ACCOUNT_JSON` secret are configured. The deployment account has Firebase Hosting Admin and API Keys Viewer. Hosting Admin applies to all Hosting sites in the project; the workflow targets only `hosting:quotes`. Its private key is held in GitHub Secret, never in the repository or distributable ZIP. The unused extra key was deleted. The working key expires October 3, 2036.

## Operation

For a manual retry, select **Run workflow → mode: update → Run workflow**. Inspect the green/red result and logs. GitHub may delay a scheduled run. After an outage, the updater catches up from the last published candles.

**Bootstrap** is only for initial disaster recovery from the journal's bundled archive. It preserves its original generation timestamp and adds checksums without requesting new candles. Do not select bootstrap for routine updates: it can restore an older snapshot.

The updater preserves the H1 and yearly M5 binary format, requests a 7-day overlap, validates SHA-256, timestamps and OHLC, and stages all four assets before publication. Missing overlap, corrupted files, inconsistent recovery or network failures stop publication and leave the live archive intact. No new candles or corrections means no release. H1 monthly buckets are fetched once; HTTP failures are explicitly retried. If H1 is unavailable, gaps can be recovered from the same provider's M1 candles after validation against archived hours (at most two ticks of endpoint rounding) and native H1 high/low overlap. Existing archived/native H1 takes precedence; only new missing hours use minute aggregation. Zero-volume hours are excluded. Legacy October 2024 OHLC inconsistencies of up to two ticks are preserved; new prices are validated strictly.

Replay checks metadata when entering the lobby, reloads changed data and verifies checksums. An active session continues with its loaded data. Return to period selection to see new dates.

## Local development

```powershell
npm ci
npm test
node tools/audit.mjs
```

`REPLAY_SOURCE_URL=https://retocker-replay-quotes.web.app/replay-data/` restores the published snapshot. Without that variable, `npm run update` operates on local seed files. Never manually deploy stale seed files over production. Configure the dedicated site with `node tools/configure.mjs retocker-replay-quotes retocker`.

The initial archive is about 82 MiB; daily restoration uses roughly 2.5 GiB/month plus visitor traffic. Hosting quotas are shared with the journal. The quotes site retains ten releases. Monitor Firebase Hosting Usage and GitHub Actions usage. The tariff was not upgraded.

References: [Firebase Hosting quotas](https://firebase.google.com/docs/hosting/usage-quotas-pricing), [scheduled Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
