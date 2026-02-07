#!/bin/bash
set -euo pipefail

CLICKHOUSE_PASSWORD="$(echo '__CLICKHOUSE_PASSWORD_B64__' | base64 --decode)"

# 1) Install Docker and CloudWatch agent.
dnf install -y docker amazon-cloudwatch-agent
systemctl enable --now docker

# 2) Configure CloudWatch metrics for memory and disk usage.
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'JSON'
{
  "metrics": {
    "append_dimensions": {
      "InstanceId": "${aws:InstanceId}"
    },
    "metrics_collected": {
      "mem": {
        "measurement": ["mem_used_percent"],
        "metrics_collection_interval": 60
      },
      "disk": {
        "measurement": ["disk_used_percent"],
        "resources": ["/data"],
        "metrics_collection_interval": 60
      }
    }
  }
}
JSON

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json \
  -s

# 3) Format and mount the attached data volume.
DATA_DEVICE="/dev/xvdf"
if [ ! -b "$DATA_DEVICE" ] && [ -b "/dev/nvme1n1" ]; then
  DATA_DEVICE="/dev/nvme1n1"
fi

if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  mkfs.ext4 "$DATA_DEVICE"
fi

mkdir -p /data
grep -q "$DATA_DEVICE /data" /etc/fstab || \
  echo "$DATA_DEVICE /data ext4 defaults,nofail 0 2" >> /etc/fstab
mount -a

# 4) Seed initial migrations for first boot.
mkdir -p /opt/clickhouse/migrations

cat > /opt/clickhouse/migrations/001_create_database.sql << 'SQL'
CREATE DATABASE IF NOT EXISTS arbinet;
SQL

cat > /opt/clickhouse/migrations/002_create_markets.sql << 'SQL'
CREATE TABLE IF NOT EXISTS arbinet.markets
(
    exchange LowCardinality(String),
    symbol String,
    exchange_symbol String,
    type LowCardinality(String),
    listing_date Nullable(DateTime),
    delisting_date Nullable(DateTime),
    is_active Bool,
    created_at DateTime DEFAULT now(),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (exchange, symbol);
SQL

cat > /opt/clickhouse/migrations/003_create_funding_rates.sql << 'SQL'
CREATE TABLE IF NOT EXISTS arbinet.funding_rates
(
    exchange LowCardinality(String),
    symbol String,
    exchange_symbol String,
    funding_time DateTime,
    funding_rate Decimal(18, 8),
    mark_price Nullable(Decimal(18, 8)),
    created_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(funding_time)
ORDER BY (exchange, symbol, funding_time);
SQL

# 5) Start ClickHouse.
docker pull clickhouse/clickhouse-server:25.5.6
docker rm -f clickhouse >/dev/null 2>&1 || true

docker run -d \
  --name clickhouse \
  --restart always \
  -p 8123:8123 \
  -p 9000:9000 \
  -v /data:/var/lib/clickhouse \
  -v /opt/clickhouse/migrations:/docker-entrypoint-initdb.d:ro \
  --ulimit nofile=262144:262144 \
  -e CLICKHOUSE_DB=arbinet \
  -e CLICKHOUSE_USER=arbinet \
  -e CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
  clickhouse/clickhouse-server:25.5.6
