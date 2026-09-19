output "urls" {
  description = "Host URLs for the platform UIs (mapped in kind-config.yaml)."
  value = {
    argocd     = "http://localhost:8091"
    grafana    = "http://localhost:3031"
    prometheus = "http://localhost:9091"
    frontend   = "http://localhost:8090 (available once Phase 4 deploys the apps)"
  }
}

output "argocd_admin_password_command" {
  description = "ArgoCD generates a random initial admin password into a Secret. Printed as a command rather than read into Terraform state, so the credential never lands in terraform.tfstate."
  value       = "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
}

output "grafana_login" {
  description = "Grafana credentials (local only)."
  value       = "admin / ${var.grafana_admin_password}"
  sensitive   = true
}

output "verify_commands" {
  description = "Quick checks that the platform came up correctly."
  value = {
    all_pods_running   = "kubectl get pods -A"
    prometheus_targets = "open http://localhost:9091/targets -- every listed target should be UP (control-plane scrapers are disabled on purpose)"
    loki_ready         = "kubectl -n logging exec deploy/loki -- wget -qO- localhost:3100/ready"
    logs_flowing       = "In Grafana > Explore > Loki, run: {namespace=\"logging\"}"
  }
}
