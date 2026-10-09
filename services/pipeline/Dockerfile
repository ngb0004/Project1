# syntax=docker/dockerfile:1
#
# The pipeline worker as a long-running service (`pipeline worker`).
#
# Build from the repository root (the worker needs the shared packages):
#   docker build -f services/pipeline/Dockerfile -t sia-pipeline-worker .
#
# Run next to a Supabase project (see services/pipeline/README.md):
#   docker run -d --name sia-pipeline-worker --restart unless-stopped --stop-timeout 60 \
#     --env-file pipeline.env sia-pipeline-worker
#
# The worker signs in as the pipeline account with the anon key; never give it
# the service-role key. On `docker stop` it stops claiming jobs and releases the
# job in progress back to the queue (allow it PIPELINE_SHUTDOWN_GRACE_SECONDS
# plus ~15 s with --stop-timeout).

FROM node:22-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/case-schema/package.json packages/case-schema/
COPY packages/case-store/package.json packages/case-store/
COPY services/pipeline/package.json services/pipeline/
# Only the worker and the two packages it uses. The repository's hoisted layout
# would install every app's dependencies; the isolated linker installs the
# worker's alone (tsx comes from the workspace root).
RUN pnpm install --frozen-lockfile --config.node-linker=isolated --filter "@sia/pipeline..."

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PIPELINE_HEALTH_FILE=/tmp/pipeline-worker.alive
WORKDIR /app
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages/case-schema packages/case-schema
COPY packages/case-store packages/case-store
COPY services/pipeline services/pipeline
USER node
# The worker touches the health file on every poll and every heartbeat (at least once a minute).
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD test -n "$(find "$PIPELINE_HEALTH_FILE" -mmin -5 2>/dev/null)" || exit 1
STOPSIGNAL SIGTERM
# One Node process (tsx as a loader, not a wrapper), so SIGTERM reaches the worker itself.
ENTRYPOINT ["node", "--import", "tsx", "services/pipeline/src/cli.ts"]
CMD ["worker"]
