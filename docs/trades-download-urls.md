# Historical Trades Data — Download URL Reference

Static-storage URL templates for downloading historical **aggregated/tick trades** data (orderbook data excluded) for USDT-margined perpetual futures on 6 exchanges. All timestamps are UTC unless noted.

| Exchange | URL template | Params | Symbol format |
|---|---|---|---|
| Binance | `https://data.binance.vision/data/futures/um/daily/aggTrades/{SYMBOL}/{SYMBOL}-aggTrades-{YYYY-MM-DD}.zip` | `SYMBOL`, `date` | Raw exchange symbol, e.g. `BTCUSDT` |
| Bybit | `https://public.bybit.com/trading/{SYMBOL}/{SYMBOL}{YYYY-MM-DD}.csv.gz` | `SYMBOL`, `date` | e.g. `BTCUSDT` |
| OKX | `https://static.okx.com/cdn/okex/traderecords/trades/daily/{YYYYMMDD}/{SYMBOL}-trades-{YYYY-MM-DD}.zip` | `SYMBOL`, `date` | Swap format, e.g. `BTC-USDT-SWAP` |
| Bitget | `https://img.bitgetimg.com/online/trades/UMCBL/{SYMBOL}/{YYYYMMDD}_{PART}.zip` | `SYMBOL`, `date`, `PART` (3-digit, `001`, `002`, ...) | e.g. `BTCUSDT` |
| Gate.io | `https://download.gatedata.org/futures_usdt/trades/{YYYYMM}/{SYMBOL}-{YYYYMM}.csv.gz` | `SYMBOL`, `month` | Underscore format, e.g. `BTC_USDT` |
| KuCoin | `https://historical-data.kucoin.com/data/futures/daily/trades/{SYMBOL}/{SYMBOL}-trades-{YYYY-MM-DD}.zip` | `SYMBOL`, `date` | Futures contract with `M` suffix, e.g. `BTCUSDTM` (BTC is `BTCUSDTM`, not `XBTUSDTM`) |

## Notes per exchange

- **Binance**: one file per symbol per UTC day. Standard daily archive, no special quirks.
- **Bybit**: one file per symbol per UTC day. `public.bybit.com` is a plain static file host (browsable directory listing).
- **OKX**: one file per symbol per UTC day, grouped under a `{YYYYMMDD}` folder as well as embedded in the filename.
- **Bitget**: files are split into UTC+8-day-boundary "parts" — a single UTC calendar day requires fetching parts from both day D and day D+1 (UTC+8). The number of parts varies per symbol-day and is not published, so parts must be probed sequentially (`001`, `002`, ...) until a request fails. A missing part returns HTTP 403, not 404.
- **Gate.io**: files are grouped **monthly**, not daily — one file covers an entire calendar month for a symbol.
- **KuCoin**: one file per symbol per UTC day. Contract symbols follow KuCoin's own futures naming (append `M` to the USDT pair, e.g. `ETHUSDTM`), which does not always match other exchanges' naming for the same coin.

## Verification

All six templates were checked live (HTTP 200, or a directory/bucket listing where applicable) as of 2026-09-18 using symbol `BTCUSDT` / `BTC-USDT-SWAP` / `BTC_USDT` / `BTCUSDTM` as appropriate, date `2025-01-09`, and month `202501` for Gate.io.

## Download engine logic (battle-tested, reuse when building from scratch)

Generic engine, works across all 6 exchanges:

- **Retry with exponential backoff + jitter**: on retriable failure, wait `min(maxBackoff, base * 2^attempt) + random(0, 25% of that)`, then retry. Defaults that work well: `maxRetries=5`, `backoffBase=1000ms`, `backoffMax=30000ms`, per-request `timeout=300000ms` (abort via `AbortController`).
- **Retriable vs fatal errors**: retry on `AbortError` (timeout), network-level `TypeError`/"network" errors, and any 5xx HTTP status. Do NOT retry on 4xx (except see "not-found" below) — those are fatal/skip conditions.
- **"Not found" detection is exchange-specific — don't hardcode 404**: most CDNs return 404 for a missing file/date/part, but **Bitget's CDN returns 403** (never 404) for an absent key. Treat `{403, 404}` as "not found" generically, and let it short-circuit retries (no point retrying a permanent miss).
- **Atomic writes**: stream the HTTP response body to a temp file (`{destPath}.part-{pid}-{timestamp}-{random}`) via `pipeline(Readable.fromWeb(response.body), writeStream)`, then `rename()` to the final path only on success. Prevents partial/corrupt files if the process dies mid-download, and makes "does this file already exist locally" a safe check.
- **HEAD-probe before downloading when existence is uncertain**: a lightweight `HEAD` request (same retry/backoff/timeout logic, same not-found-status handling) avoids wasting bandwidth on GET when just checking whether a symbol/date/part exists.
- **Bounded concurrency worker pool**: a shared `nextIndex` counter consumed by N concurrent workers (`Promise.all` over `workerCount` loops) is simpler and more robust than `Promise.all(urls.map(...))` — it naturally throttles concurrency and keeps memory bounded for large date-range backfills. `workerCount = max(1, min(desiredConcurrency, urls.length))`.
- **`skipNotFound` mode for batch jobs**: when bulk-downloading a date range per symbol, treat a "not found" result as "this symbol/date has no data" and continue rather than aborting the whole batch — useful for symbols that delisted mid-range or don't trade every day.

### Exchange-specific quirks worth replicating

- **Bitget — unbounded part enumeration**: file count per symbol-day isn't published. Probe part `001`, `002`, `003`, ... via HEAD, incrementing until a probe returns "not found"; stop there. Add a hard safety cap (e.g. 200 parts) so a CDN glitch can't turn this into an infinite scan.
- **Bitget — UTC+8 day boundary**: Bitget's daily files are cut on UTC+8 boundaries, not UTC. To get one full UTC calendar day of trades, fetch parts for **both day D and day D+1** (UTC+8) and probe each independently — an empty second day is normal at the edge of a symbol's listing, not an error.
- **Gate.io — monthly grouping**: trades files are one-per-month, not one-per-day like the other 5 exchanges. Don't loop per-day when building the URL — group the requested date range into months first, then dedupe to one download per (symbol, month).
- **Per-exchange symbol normalization**: each exchange's CDN symbol differs from its "canonical" USDT-quoted symbol (OKX adds `-SWAP` suffix, Gate.io uses underscore, KuCoin appends `M` and doesn't always share the base-asset ticker with other exchanges e.g. `BTC`). Keep a small `toUrlSymbol(canonicalSymbol) -> exchangeSymbol` mapping function per exchange rather than string-templating the canonical symbol directly.
