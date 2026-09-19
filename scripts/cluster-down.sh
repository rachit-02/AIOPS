#!/usr/bin/env bash
# Tears down the local cluster.
#
#   bash scripts/cluster-down.sh
#
# Deleting the kind cluster removes every container, volume and image the
# cluster owned, so there is nothing left to leak. Terraform state is stale
# afterwards, which is why it is removed too: a state file describing releases
# in a cluster that no longer exists would make the next apply fail confusingly.
set -euo pipefail

CLUSTER=aiops-local
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind delete cluster --name "$CLUSTER"
else
  echo "Cluster $CLUSTER does not exist."
fi

rm -f "$ROOT/infra/terraform/terraform.tfstate" \
      "$ROOT/infra/terraform/terraform.tfstate.backup"
echo "Local Terraform state cleared. Next cluster-up.sh starts clean."
