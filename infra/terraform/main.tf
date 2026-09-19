# =============================================================================
# The platform layer: everything that must exist on the cluster BEFORE any
# application is deployed.
#
# PREREQUISITE: the cluster must already exist.
#     kind create cluster --config infra/terraform/kind-config.yaml
# (scripts/cluster-up.sh runs both steps in the right order.)
#
# WHY TERRAFORM OWNS THIS AND NOT ARGOCD
# There is a bootstrap ordering problem: ArgoCD cannot install itself, and it
# cannot manage the monitoring stack until it is running. So Terraform installs
# the platform once, and from Phase 4 onward ArgoCD owns every APPLICATION
# manifest. That boundary -- Terraform for the platform, GitOps for the apps --
# is the standard resolution and is worth stating plainly in a viva, because
# "why isn't this in Git too?" is an obvious question.
#
# All chart configuration lives in values/*.yaml rather than inline `set`
# blocks: YAML is what the chart authors document, it diffs cleanly in review,
# and it can be linted independently of Terraform.
# =============================================================================

# -----------------------------------------------------------------------------
# 1. Loki -- log aggregation. Installed FIRST because Grafana (below) declares a
#    datasource pointing at it, and Fluent Bit ships to it.
# -----------------------------------------------------------------------------
resource "helm_release" "loki" {
  name             = "loki"
  repository       = "https://grafana.github.io/helm-charts"
  chart            = "loki"
  version          = var.loki_chart_version
  namespace        = "logging"
  create_namespace = true

  values = [templatefile("${path.module}/values/loki.yaml", {
    retention = var.loki_retention
  })]

  # Loki's first start initialises its filesystem store; the default 5m can be
  # tight on a laptop under load.
  timeout = 600
  wait    = true
}

# -----------------------------------------------------------------------------
# 2. Fluent Bit -- the log SHIPPER. Runs as a DaemonSet, so one pod per node
#    tails every container's stdout on that node.
#
#    This is the piece that replaced CloudWatch. Note what did NOT change: the
#    services still just write JSON to stdout. Swapping the entire log backend
#    touched one comment in application code.
# -----------------------------------------------------------------------------
resource "helm_release" "fluent_bit" {
  name             = "fluent-bit"
  repository       = "https://fluent.github.io/helm-charts"
  chart            = "fluent-bit"
  version          = var.fluent_bit_chart_version
  namespace        = "logging"
  create_namespace = true

  values = [file("${path.module}/values/fluent-bit.yaml")]

  # Shipping to a Loki that isn't up yet produces a pod in CrashLoop and a
  # confusing first-run experience.
  depends_on = [helm_release.loki]
}

# -----------------------------------------------------------------------------
# 3. kube-prometheus-stack -- Prometheus + Grafana (+ Alertmanager, disabled).
#    Grafana is configured with BOTH datasources, so a human can corroborate
#    anything Kira claims by looking at the same metrics and logs she queried.
# -----------------------------------------------------------------------------
resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = var.kube_prometheus_stack_chart_version
  namespace        = "monitoring"
  create_namespace = true

  values = [templatefile("${path.module}/values/kube-prometheus-stack.yaml", {
    enable_alertmanager     = var.enable_alertmanager
    prometheus_retention    = var.prometheus_retention
    prometheus_memory_limit = var.prometheus_memory_limit
    grafana_admin_password  = var.grafana_admin_password
  })]

  # The stack installs CRDs and waits for the operator; 5m is often not enough
  # on a cold laptop pulling ~1.2GB of images.
  timeout = 900
  wait    = true

  # Grafana's Loki datasource resolves at query time, but ordering the install
  # means the datasource works the first time you open Grafana.
  depends_on = [helm_release.loki]
}

# -----------------------------------------------------------------------------
# 4. ArgoCD -- the GitOps engine. Installed last: it has no dependencies, and
#    putting it at the end means a failed monitoring install doesn't leave a
#    half-configured ArgoCD syncing into a broken cluster.
#
#    Phase 4 points it at infra/k8s/overlays/dev.
# -----------------------------------------------------------------------------
resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argocd_chart_version
  namespace        = "argocd"
  create_namespace = true

  values = [file("${path.module}/values/argocd.yaml")]

  timeout = 900
  wait    = true
}

# -----------------------------------------------------------------------------
# 5. The bootstrap seed: the single root Application, applied AFTER ArgoCD.
#
# WHY THIS IS A kubectl CALL AND NOT A PROPER RESOURCE
# The obvious options both fail here:
#   - putting it in the chart's `extraObjects` fails on a CLEAN cluster,
#     because the Helm provider renders and validates the whole manifest set
#     against the API server before applying, and the Application CRD does not
#     exist yet at that moment (this is a real failure that a destroy/recreate
#     caught, not a hypothetical);
#   - `kubernetes_manifest` from the kubernetes provider needs the CRD to exist
#     at PLAN time, which on a fresh cluster it does not.
#
# So the one bootstrap object is applied imperatively, from a manifest that
# still lives in Git and is still reviewable. `kubectl apply` is idempotent, so
# re-running is safe, and the manifest's own hash is the trigger, so editing it
# re-applies it.
#
# This is the documented GitOps exception, and it is exactly one object wide.
# -----------------------------------------------------------------------------
resource "terraform_data" "argocd_root_application" {
  triggers_replace = {
    manifest = filesha256("${path.module}/../k8s/argocd/root-application.yaml")
  }

  provisioner "local-exec" {
    command = join(" ", [
      "kubectl", "--context", "kind-${var.cluster_name}",
      "apply", "-f", "${path.module}/../k8s/argocd/root-application.yaml",
    ])
  }

  depends_on = [helm_release.argocd]
}
