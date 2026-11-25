# Reset every product's stock to a fixed level (default 50) before a demo.
#
#   .\scripts\restock.ps1              # set all products to 50
#   .\scripts\restock.ps1 -Stock 80    # set all products to 80
#   .\scripts\restock.ps1 -Check       # only show current stock, change nothing
#
# PowerShell twin of scripts/restock.sh - see that file for the reasoning.
# One UPDATE, run inside the cluster's Postgres pod as aiops_product over the
# pod's local socket (no password). Never DROPs, TRUNCATEs or DELETEs.
param(
  [ValidateRange(0, 100000)]
  [int]$Stock = 50,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'

$Ctx = 'kind-aiops-local'
$Ns = 'aiops-dev'
$Pod = 'postgres-0'
$Db = 'aiops'
$DbUser = 'aiops_product'

$CountSql = 'SELECT count(*) AS products, count(*) FILTER (WHERE stock > 0) AS in_stock, coalesce(sum(stock), 0) AS total_units, min(stock) AS min_stock, max(stock) AS max_stock FROM product_svc.products;'

function Invoke-Psql([string]$Sql) {
  & kubectl --context $Ctx -n $Ns exec $Pod -- psql -U $DbUser -d $Db -v ON_ERROR_STOP=1 -P pager=off -c $Sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE)" }
}

if ($Check) {
  Invoke-Psql $CountSql
  return
}

$UpdateSql = "UPDATE product_svc.products SET stock = $Stock;"

Write-Output "context: $Ctx   pod: $Ns/$Pod   db: $Db   user: $DbUser"
Write-Output ''
Write-Output 'before:'
Invoke-Psql $CountSql
Write-Output "SQL: $UpdateSql"
Invoke-Psql $UpdateSql
Write-Output ''
Write-Output 'after:'
Invoke-Psql $CountSql
