# user service image. Build context MUST be ./services (not ./services/user)
# because the code imports ../../_shared - see docker-compose.yml `build.context`.

# ---- Stage 1: install production deps (npm lives only in this stage) ----
FROM node:22-alpine AS deps
WORKDIR /app
# Manifests first: this layer stays cached until dependencies change, so
# ordinary code edits don't re-run npm ci.
COPY _shared/package.json _shared/package-lock.json ./_shared/
COPY user/package.json user/package-lock.json ./svc/
# mkdir: services with no deps of their own would otherwise have no node_modules to copy.
RUN cd _shared && npm ci --omit=dev && cd ../svc && npm ci --omit=dev && mkdir -p node_modules

# ---- Stage 2: minimal runtime ----
FROM node:22-alpine
ENV NODE_ENV=production
# /app/svc + /app/_shared mirrors the repo layout so ../../_shared resolves
# identically on a laptop and in the container.
WORKDIR /app/svc
COPY --from=deps /app/_shared/node_modules /app/_shared/node_modules
COPY _shared/package.json _shared/index.js /app/_shared/
COPY --from=deps /app/svc/node_modules ./node_modules
COPY user/package.json ./
COPY user/src ./src
# Unprivileged user shipped in the base image: a compromised service cannot
# write to the image filesystem or bind privileged ports.
#
# NUMERIC, not `USER node`. Kubernetes refuses to start a container with
# runAsNonRoot: true when the image's user is a NAME, because it cannot
# resolve it to a uid and therefore cannot prove the user is not root:
#   "container has runAsNonRoot and image has non-numeric user (node)"
# 1000:1000 is the `node` user in node:22-alpine (`id -u node`). Declaring it
# numerically makes the image satisfy that check on its own, rather than
# relying on every Deployment to set runAsUser.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3   CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
