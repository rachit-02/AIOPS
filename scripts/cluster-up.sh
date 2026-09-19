#!/usr/bin/env bash
# Brings up the full local platform: kind cluster + Terraform-managed charts.
#
#   bash scripts/cluster-up.sh
#
# Safe to re-run: kind skips an existing cluster and `terraform apply` is
# idempotent.
set -euo pipefail

CLUSTER=aiops-local
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n=== %s ===\n' "$1"; }
die()  { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

# ---- Preflight ---------------------------------------------------------------
step "Preflight"
for tool in kind kubectl terraform docker; do
  command -v "$tool" >/dev/null || die "$tool is not installed. See README > Prerequisites."
done
docker info >/dev/null 2>&1 || die "Docker is not running."

# The cluster and the compose stack together exceed the memory available to
# Docker. Refuse rather than let the user discover this via OOMKilled pods.
if [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
  die "The docker-compose stack is running. Stop it first: docker compose down"
fi

# kind pulls a node image and then pulls every workload image again INSIDE the
# node containers, because kind does not share Docker's image store.
avail=$(docker run --rm alpine:3.20 df -P /var/lib/docker 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}' || echo 0)
if [ "${avail:-0}" -gt 0 ] && [ "$avail" -lt 8 ]; then
  printf 'WARNING: only %sGB free in the Docker VM. ~5GB is needed.\n' "$avail"
  printf 'Reclaim space with:  docker builder prune -f && docker image prune -a -f\n\n'
  read -r -p 'Continue anyway? [y/N] ' reply
  [ "$reply" = y ] || exit 1
fi

# ---- 1. Cluster --------------------------------------------------------------
step "kind cluster: $CLUSTER"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "Cluster already exists, reusing it."
else
  kind create cluster --config infra/terraform/kind-config.yaml --wait 120s
fi

# Terraform targets this context explicitly, so make sure it resolves.
kubectl config use-context "kind-${CLUSTER}" >/dev/null
kubectl cluster-info --context "kind-${CLUSTER}" >/dev/null || die "Cluster is not reachable."
kubectl get nodes

# ---- 2. Platform charts ------------------------------------------------------
step "Terraform: ArgoCD + kube-prometheus-stack + Loki + Fluent Bit"
cd infra/terraform
terraform init -input=false
terraform apply -input=false -auto-approve

# ---- 3. Report ---------------------------------------------------------------
step "Cluster ready"
cd "$ROOT"
kubectl get pods -A --no-headers | awk '{print $4}' | sort | uniq -c
cat <<EOF

  ArgoCD      http://localhost:8091   (admin / see command below)
  Grafana     http://localhost:3031   (admin / admin)
  Prometheus  http://localhost:9091

  ArgoCD admin password:
    kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d

  Verify logs are flowing -- Grafana > Explore > Loki:
    {namespace="logging"}

  Tear down:
    kind delete cluster --name $CLUSTER
EOF
