variable "cluster_name" {
  description = "kind cluster name. Must match the `name` in kind-config.yaml; the kubectl context becomes kind-<cluster_name>."
  type        = string
  default     = "aiops-local"
}

variable "kubeconfig_path" {
  description = "Path to kubeconfig. kind writes to the default ~/.kube/config."
  type        = string
  default     = "~/.kube/config"
}

# NOTE ON NODE COUNT
# Worker count is NOT a Terraform variable: the kind CLI owns cluster creation,
# so node topology lives in kind-config.yaml. Exposing a variable here that
# Terraform could not actually enforce would be a lie in the interface.

# ---------------------------------------------------------------------------
# Chart versions. Pinned so `terraform apply` produces the same cluster today
# and in six months. Upgrading is then a visible, reviewable commit.
# ---------------------------------------------------------------------------
variable "argocd_chart_version" {
  description = "argo/argo-cd chart version"
  type        = string
  default     = "10.9.2"
}

variable "kube_prometheus_stack_chart_version" {
  description = "prometheus-community/kube-prometheus-stack chart version"
  type        = string
  default     = "91.4.1"
}

variable "loki_chart_version" {
  description = "grafana/loki chart version"
  type        = string
  default     = "7.3.0"
}

variable "fluent_bit_chart_version" {
  description = "fluent/fluent-bit chart version"
  type        = string
  default     = "0.58.2"
}

# ---------------------------------------------------------------------------
# Resource tuning. Defaults target a 16GB laptop with ~7.6GB allocated to
# Docker; the whole stack lands around 5.5GB, leaving room for the host.
# ---------------------------------------------------------------------------
variable "enable_alertmanager" {
  description = "Alertmanager adds ~200MB and this project has no alert routes: Kira is the consumer of anomalies, not PagerDuty. Off by default."
  type        = bool
  default     = false
}

variable "prometheus_retention" {
  description = "Short retention keeps Prometheus memory and disk small. Incidents are diagnosed minutes after they happen, not days."
  type        = string
  default     = "6h"
}

variable "prometheus_memory_limit" {
  description = "Hard ceiling for Prometheus. Without a limit it grows until the node evicts something else."
  type        = string
  default     = "1536Mi"
}

variable "grafana_memory_limit" {
  description = <<-EOT
    Hard ceiling for Grafana. Raised from 256Mi after repeated OOMKills, then
    again from 512Mi after measuring it under real dashboard load.

    256Mi: steady-state working set was 253Mi, i.e. ~99% of the ceiling, and
    the kernel reaped the container roughly every 15 minutes.

    512Mi: fine while idle (~385Mi) but NOT under load. With the Three Signals
    dashboard open in a browser - refresh 10s, a now-30m window, and a Loki
    panel doing `| json` over maxLines=1000 - usage climbed to 510Mi within
    four minutes and the readiness probe began failing. That is the demo
    workload, so idle numbers were never the right thing to size against.

    1Gi gives roughly 2x headroom over the observed 510Mi peak. The three kind
    nodes share a single 7.56GiB Docker VM, which had ~3.8GiB free, so this is
    affordable. Grafana 12's unified apiserver and SQLite store are what the
    original 256Mi figure predates.
  EOT
  type        = string
  default     = "1Gi"
}

variable "loki_retention" {
  description = "Log retention in Loki. Same reasoning as prometheus_retention."
  type        = string
  default     = "24h"
}

variable "grafana_admin_password" {
  description = "Local-only credential. Real deployments would source this from a secret manager; here the cluster is disposable and never exposed beyond localhost."
  type        = string
  default     = "admin"
  sensitive   = true
}
