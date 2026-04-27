# Grafana Dashboard — Execution Engine

## Import

1. In Grafana, go to **Dashboards → Import**.
2. Upload `execution-engine.json` or paste its contents.
3. Select your Prometheus datasource as **DS_PROMETHEUS**.
4. Click **Import**.

## Datasource setup

The dashboard expects a Prometheus datasource scraping the execution engine's `/metrics` endpoint (default port `9464`).

Add a scrape job to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: execution-engine
    static_configs:
      - targets: ['localhost:9464']
```

## Panels

| Panel | Metric |
|-------|--------|
| Placement Latency p50/p95/p99 | `intent_entry_latency_ms` |
| Fill Rate | `intents_filled_total / intents_decided_total` |
| Reject Rate by Code | `intents_rejected_total{code}` |
| WS Event Lag p95 | `ws_event_lag_ms` |
| WS Reconnects/min | `ws_reconnect_total` |
| Realized PnL | `pnl_realized_total{strategy,exchange}` |
| Persistence Queue | `persistence_queue_size`, `persistence_dropped_total` |
| Recovery Orphans | `recovery_orphans_flattened_total`, `recovery_orphans_cancelled_total` |
| Intent State Distribution | `intents_open{status}` |
| Persistence Flush Duration | `persistence_flush_duration_ms` |
| Persistence Writes/sec | `persistence_writes_total{table,result}` |
