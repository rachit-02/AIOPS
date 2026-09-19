# DESIGN NOTE — the original AWS design (superseded)

> ## ⚠️ This is not the current architecture
>
> This document describes the **original** Phase 2 design, which pushed images
> to Amazon ECR using a GitHub OIDC federated IAM role. **None of it is
> deployed.** The project was deliberately re-targeted to run entirely on one
> machine — GHCR instead of ECR, kind instead of EKS, Loki instead of
> CloudWatch — to remove a recurring cost of roughly **$105/month** (EKS
> control plane + NAT gateway) from a student project.
>
> **It is kept because the reasoning is worth defending in a viva**, in
> particular:
>
> - **Why the OIDC trust policy's `sub` condition is security-critical.**
>   Without it, *any* GitHub Actions workflow in *any* repository on GitHub
>   could assume the role. This is one of the most common real-world OIDC
>   misconfigurations, and the analysis below still stands.
> - **How to scope an IAM policy minimally**, and why exactly one action
>   (`ecr:GetAuthorizationToken`) legitimately requires `Resource: "*"` while
>   every action that touches image data is ARN-scoped.
> - **What CI deliberately could not do** — no delete permissions, no cluster
>   credentials — which is the same blast-radius argument the current GHCR
>   pipeline makes.
>
> For what actually runs today, see [the README](../../README.md).

---

## AWS + GitHub setup for CI (as originally designed)

Manual, one-time setup. Everything here had to exist **before** the first push
to `main`, or the `build` job would fail at the "Assume AWS role" step.

**Cost of this phase: effectively zero.** ECR's free tier covers 500 MB/month
for 12 months; beyond that it is $0.10/GB/month. With the lifecycle policy in
Step 1 the repos stay near ~2 GB, so **under $0.25/month**. IAM, OIDC and
GitHub Actions minutes (public repo) are free. No compute runs in AWS yet.

Set these once per shell:

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export GH_OWNER=<your-github-username>
export GH_REPO=<your-repo-name>
echo "Account: $ACCOUNT_ID  Repo: $GH_OWNER/$GH_REPO"
```

---

## Step 1 — Create the 7 ECR repositories

```bash
for svc in frontend gateway auth product order orders user; do
  aws ecr create-repository \
    --repository-name "aiops-dev-$svc" \
    --region "$AWS_REGION" \
    --image-scanning-configuration scanOnPush=true \
    --image-tag-mutability IMMUTABLE \
    --query 'repository.repositoryUri' --output text
done
```

Two flags worth defending in a viva:

- **`IMMUTABLE` tags.** Once `aiops-dev-order:a1b2c3d` exists, nothing can
  overwrite it. A given tag always means the same bytes forever, so "roll back
  to a1b2c3d" is guaranteed to restore the code that commit produced. With
  mutable tags, a re-run of CI could silently replace an image that pods are
  already running, and two pods on the "same version" could differ.
- **`scanOnPush`.** Free CVE scan of OS packages on every push. Costs nothing
  and gives you something concrete to say about supply-chain security.

> **`IMMUTABLE` and `latest` are incompatible — by design.** The workflow
> pushes exactly one tag per image (the short SHA) and never `latest`, so
> immutability is free. If you ever add a `latest` tag back, this setting will
> fail the build on the second push. That failure is a feature: it stops you
> reintroducing a mutable pointer into the deploy path.

### Lifecycle policy — keeps storage from growing forever

Every push adds ~255 MB × 7. Without expiry this grows without bound.

```bash
cat > /tmp/lifecycle.json <<'EOF'
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Expire untagged images after 1 day (build leftovers)",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 1
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Keep the 10 most recent images; older ones are unreachable rollback targets anyway",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    }
  ]
}
EOF

for svc in frontend gateway auth product order orders user; do
  aws ecr put-lifecycle-policy \
    --repository-name "aiops-dev-$svc" \
    --lifecycle-policy-text file:///tmp/lifecycle.json \
    --region "$AWS_REGION" >/dev/null && echo "policy set: aiops-dev-$svc"
done
```

> **Phase 3 conflict — read this now.** Terraform will also want to manage ECR.
> When you get there, either `terraform import` these repos into state, or
> reference them with a `data "aws_ecr_repository"` block. Do **not** let
> Terraform create repos with the same names; it will fail on "already exists".
> Creating them by hand now is the right call because CI needs them
> immediately and Phase 3 is several steps away.

---

## Step 2 — Register GitHub as an OIDC identity provider

This tells AWS to trust tokens signed by GitHub. One per AWS account — check
first, since another project may have created it.

```bash
aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn,'token.actions.githubusercontent.com')]"
```

If that returns `[]`, create it:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

> The thumbprint is legacy. AWS now validates GitHub's OIDC endpoint against
> its own trusted CA store and ignores this value for this provider, but the
> API still requires the parameter.

---

## Step 3 — Create the IAM role CI assumes

### 3a. Trust policy — *who* may assume the role

**This is the security-critical file.** Read the warning below it.

```bash
cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:${GH_OWNER}/${GH_REPO}:ref:refs/heads/main"
        }
      }
    }
  ]
}
EOF
cat /tmp/trust-policy.json
```

> ### The `sub` condition is not optional
>
> Without it — or with it loosened to `repo:*` — **any GitHub Actions workflow
> in any repository on GitHub could assume this role** and push images into
> your ECR. This is one of the most common real-world OIDC misconfigurations.
>
> Both conditions matter and do different jobs:
> - `aud` (`sts.amazonaws.com`) confirms the token was minted *for AWS*, so a
>   token issued for some other service can't be replayed here.
> - `sub` confirms *which repo and which branch*. `repo:owner/repo:ref:refs/heads/main`
>   means: this repository, and only pushes to `main`.
>
> `StringEquals` is used rather than `StringLike` deliberately — no wildcards
> means no accidental over-matching. The cost is that PR builds cannot assume
> the role, which is exactly what we want: the `build` job is already gated to
> `push` events, so an unreviewed branch can never reach ECR.
>
> If you later need PR builds or environments, add specific extra `sub` values
> (for example `repo:owner/repo:pull_request`) rather than introducing a `*`.

Create the role:

```bash
aws iam create-role \
  --role-name aiops-dev-github-actions \
  --assume-role-policy-document file:///tmp/trust-policy.json \
  --description "Assumed by GitHub Actions via OIDC to push images to ECR" \
  --max-session-duration 3600 \
  --query 'Role.Arn' --output text
```

Save the printed ARN — it becomes the `AWS_ROLE_ARN` secret.

### 3b. Permissions policy — *what* the role may do

```bash
cat > /tmp/ecr-push-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GetLoginTokenAccountWide",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PushAndPullOnlyTheSevenAiopsRepos",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/aiops-dev-*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name aiops-dev-github-actions \
  --policy-name ecr-push \
  --policy-document file:///tmp/ecr-push-policy.json
```

#### What each permission is for, and why this is minimal

| Action | Why it's needed |
|---|---|
| `ecr:GetAuthorizationToken` | Exchanges IAM credentials for a Docker registry password. `docker login` cannot happen without it. |
| `ecr:BatchCheckLayerAvailability` | Lets the client skip uploading layers ECR already has — this is what makes rebuilds fast. |
| `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` | The three-step chunked upload of a single image layer. |
| `ecr:PutImage` | Writes the manifest that binds layers to a tag. This is the step that actually creates `aiops-dev-order:a1b2c3d`. |
| `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` | Read access, so buildx can compare against an existing image instead of re-uploading everything. |

**Why `GetAuthorizationToken` is on `"*"` and the rest are not.** It is an
account-level operation with no resource to attach to — AWS does not support
resource-level permissions for it, so `"*"` is the only valid value. Everything
that actually touches image data is scoped by ARN to `aiops-dev-*`, so this
role cannot read or write any other ECR repository in the account.

**What this role deliberately cannot do:**

- No `ecr:DeleteRepository` or `ecr:BatchDeleteImage` — CI can add images but
  never destroy them, so a compromised pipeline cannot erase your rollback
  targets.
- No EKS, S3, EC2 or IAM access of any kind.
- **No cluster credentials at all.** This is the architectural point: CI cannot
  deploy. It pushes images and writes a Git commit; ArgoCD pulls. A compromised
  CI token cannot reach the cluster.

---

## Step 4 — Add the two GitHub secrets

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `AWS_ROLE_ARN` | The role ARN from Step 3a, e.g. `arn:aws:iam::123456789012:role/aiops-dev-github-actions` |
| `AWS_ACCOUNT_ID` | Your 12-digit account id (`echo $ACCOUNT_ID`) |

> Neither is a credential — the ARN and account id are identifiers, not
> secrets, and they grant nothing on their own without the trust policy
> matching your repo. They are stored as secrets only to keep the account id
> out of public logs. There are **no long-lived AWS keys anywhere in this
> project**; that is the entire reason for using OIDC.

---

## Step 5 — Allow the bot to push to `main`

The `gitops` job commits the image-tag bump back to `main`. Check
**Settings → Actions → General → Workflow permissions** is set to
**Read and write permissions**.

If you protect `main` (recommended for a PR-based workflow), the bot's push
will be rejected unless you either:

- add `github-actions[bot]` to the branch-protection **bypass list**, or
- leave "Require a pull request before merging" **off** for now.

> A stricter production pattern is to keep manifests in a *separate* repo that
> CI can write to freely, leaving application `main` fully protected. Worth
> mentioning in a viva as the next step; a single repo is the right call at
> this scale.

---

## Step 6 — Verify

```bash
# Repos exist
aws ecr describe-repositories --region "$AWS_REGION" \
  --query 'repositories[?starts_with(repositoryName,`aiops-dev-`)].repositoryName' --output table

# Role exists and trusts only your repo on main
aws iam get-role --role-name aiops-dev-github-actions \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition' --output json

# Policy is attached and scoped
aws iam get-role-policy --role-name aiops-dev-github-actions --policy-name ecr-push \
  --query 'PolicyDocument.Statement[*].Resource' --output json
```

Then push to `main` and watch the Actions tab. A successful run ends with a
`chore(deploy): <sha> [skip ci]` commit from `github-actions[bot]` touching
only `infra/k8s/overlays/dev/kustomization.yaml`.

---

## Teardown

```bash
for svc in frontend gateway auth product order orders user; do
  aws ecr delete-repository --repository-name "aiops-dev-$svc" --force --region "$AWS_REGION"
done
aws iam delete-role-policy --role-name aiops-dev-github-actions --policy-name ecr-push
aws iam delete-role --role-name aiops-dev-github-actions
# Leave the OIDC provider: it is free and other projects may rely on it.
```
