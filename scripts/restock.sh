#!/usr/bin/env bash
# Reset every product's stock to a fixed level (default 50) before a demo.
#
#   bash scripts/restock.sh            # set all products to 50
#   bash scripts/restock.sh 80         # set all products to 80
#   bash scripts/restock.sh --check    # only show current stock, change nothing
#
# WHY: scripts/traffic.sh and demo checkouts buy real stock. Sold-out products
# turn healthy orders into 409s and grey out the storefront.
#
# HOW: one UPDATE, run inside the cluster's Postgres pod as aiops_product - the
# role that owns product_svc (db/init/01-schemas.sql), connecting over the
# pod's local socket (trust auth), so no password is needed or stored here.
# It never DROPs, TRUNCATEs or DELETEs anything. The context is pinned so this
# can never run against some other cluster kubectl happens to point at.
# Postgres data is not managed by ArgoCD, so self-heal does not revert it.
set -euo pipefail

CTX=kind-aiops-local
NS=aiops-dev
POD=postgres-0
DB=aiops
DB_USER=aiops_product

COUNT_SQL="SELECT count(*) AS products, count(*) FILTER (WHERE stock > 0) AS in_stock, coalesce(sum(stock), 0) AS total_units, min(stock) AS min_stock, max(stock) AS max_stock FROM product_svc.products;"

run_psql() {
  kubectl --context "$CTX" -n "$NS" exec "$POD" -- \
    psql -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1 -P pager=off -c "$1"
}

if [ "${1:-}" = "--check" ]; then
  run_psql "$COUNT_SQL"
  exit 0
fi

STOCK=${1:-50}
if ! [[ "$STOCK" =~ ^[0-9]+$ ]]; then
  echo "usage: bash scripts/restock.sh [STOCK | --check]   (STOCK is a whole number, default 50)" >&2
  exit 2
fi
UPDATE_SQL="UPDATE product_svc.products SET stock = $STOCK;"

echo "context: $CTX   pod: $NS/$POD   db: $DB   user: $DB_USER"
echo
echo "before:"
run_psql "$COUNT_SQL"
echo "SQL: $UPDATE_SQL"
run_psql "$UPDATE_SQL"
echo
echo "after:"
run_psql "$COUNT_SQL"
