# Production Server image. It only wraps a verified canonical release (scripts/release.mjs): the context is staged by
# deploy/prod/build-image.mjs and holds the Server archive, the exact artifacts/ tree and the entrypoint. Nothing is compiled or
# installed here and no source, Git metadata or private file is copied. Mutable inputs (config, proposal, logs) are bind mounts.
FROM node:24-bookworm-slim
ARG REACH_BUILD_ID
ARG REACH_REPOSITORY_COMMIT
LABEL org.opencontainers.image.title="REACH MCP Server" \
      org.opencontainers.image.version="${REACH_BUILD_ID}" \
      org.opencontainers.image.revision="${REACH_REPOSITORY_COMMIT}"
COPY server/runtime.tgz /tmp/reach-server.tgz
RUN mkdir -p /opt/reach/server /var/log/reach \
 && tar -xzf /tmp/reach-server.tgz -C /opt/reach/server --strip-components=1 --no-same-owner \
 && rm /tmp/reach-server.tgz \
 && chown node:node /var/log/reach
COPY artifacts/ /opt/reach/artifacts/
COPY entrypoint.mjs healthcheck.mjs /opt/reach/
USER node
ENV REACH_PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "/opt/reach/healthcheck.mjs"]
ENTRYPOINT ["node", "/opt/reach/entrypoint.mjs"]
