terraform {
  required_version = ">= 1.5"

  required_providers {
    helm = {
      source = "hashicorp/helm"
      # Pinned to the 2.x line. Provider versions are pinned for the same reason
      # image tags are: an unpinned provider can change how manifests render
      # with no commit in this repo to explain the change.
      version = "~> 2.17"
    }
  }

  # LOCAL STATE, DELIBERATELY.
  # An S3 + DynamoDB backend exists to stop two engineers corrupting shared
  # infrastructure. Here there is exactly one operator and the "infrastructure"
  # is a disposable local cluster, so remote state would add AWS cost and setup
  # for a problem that cannot occur. Losing terraform.tfstate is recoverable:
  # delete the cluster, recreate, re-apply.
  #
  # This is the trade-off to defend in a viva -- not an oversight.
}

provider "helm" {
  kubernetes {
    config_path = var.kubeconfig_path
    # Pinning the context matters: without it, Terraform targets whatever
    # cluster kubectl happens to point at. That is how people accidentally
    # install charts into a production cluster.
    config_context = "kind-${var.cluster_name}"
  }
}
