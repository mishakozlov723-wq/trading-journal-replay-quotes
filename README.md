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

The updater preserves the H1 and yearly M5 binary format, requests a 7-day overlap, validates SHA-256, timestamps and OHLC, and stages all four assets before publication. Missing overlap, corrupted files, inconsistent recovery or network failures stop publication and leave the live archive intact. Existing archived candles remain unchanged; no new candles means no release. The authenticated SDK pipeline is described below. Legacy October 2024 OHLC inconsistencies of up to two ticks are preserved; new prices are validated strictly.

Replay checks metadata when entering the lobby, reloads changed data and verifies checksums. An active session continues with its loaded data. Return to period selection to see new dates.

## Local development

```powershell
npm ci
npm test
node tools/audit.mjs
```

`REPLAY_SOURCE_URL=https://retocker-replay-quotes.web.app/replay-data/` restores the published snapshot. Without that variable, the updater operates on local seed files. Use `node jforex-check.mjs --prepare`, run the SDK reader with the resulting dates, then `node jforex-update.mjs`. The old `tools/update.mjs` CLI uses the blocked legacy feed and is retained for bootstrap and regression tests only. Never manually deploy stale seed files over production. Configure the dedicated site with `node tools/configure.mjs retocker-replay-quotes retocker`.

The initial archive is about 82 MiB; daily restoration uses roughly 2.5 GiB/month plus visitor traffic. Hosting quotas are shared with the journal. The quotes site retains ten releases. Monitor Firebase Hosting Usage and GitHub Actions usage. The tariff was not upgraded.

References: [Firebase Hosting quotas](https://firebase.google.com/docs/hosting/usage-quotas-pricing), [scheduled Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## JForex recovery (October 2026)

The production datafeed returned HTTP 202 with an AWS WAF challenge. The replacement reader uses the official JForex SDK over its authenticated demo connection. It reads BID history only and never submits orders. Repository secrets `DUKASCOPY_USERNAME` and `DUKASCOPY_PASSWORD` supply the demo credentials; they must never be committed or placed in command-line arguments.

`jforex-fetch.mjs` runs up to three SDK attempts with separate caches and combines only candles whose prices agree. Failed or empty chunks cannot erase successfully received data. Conflicting candles stop the run. It calls `jforex-update.mjs`, which consumes the SDK CSV export, cross-checks native H1 against M5 high/low, and recovers omitted native hours from matching M5 history. It preserves every existing archived candle and appends only timestamps after the previous final candle. The legacy feed has a few H1 open/close differences and end-of-day M5 extensions; these are checked explicitly and the archive values remain unchanged. Unrelated price differences, missing overlap, mismatched timeframes or invalid exports abort before publication.

The manual **Check JForex history (no publication)** workflow reports raw differences and stages a complete verified snapshot without deploying. The daily production workflow must use the same SDK reader and `jforex-update.mjs`. Dukascopy advertises ordinary demo accounts as 14-day accounts (https://www.dukascopy.com/swiss/english/forex/demo-fx-account/?mob=0). Continuous operation requires valid demo access: arrange an extension with the provider or replace expired credentials in GitHub Actions secrets and rerun the workflow. This migration does not make demo access permanent.



