# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

# Claude Code version is pinned so image builds are reproducible.
ARG CLAUDE_CODE_VERSION=2.1.319

ENV NODE_ENV=production \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=8080 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/workspace \
    STATE_DIR=/var/lib/agent-api \
    CLAUDE_HOME=/home/agent \
    CLAUDE_BIN=/usr/local/bin/claude \
    CLAUDE_PERMISSION_MODE=bypassPermissions \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        ripgrep \
        procps \
        tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

RUN groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent --shell /bin/bash agent \
    && mkdir -p /workspace /var/lib/agent-api \
    && chown -R agent:agent /workspace /var/lib/agent-api /home/agent

WORKDIR /app

COPY --chown=agent:agent package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=agent:agent src ./src
RUN chmod -R a+rX /app

USER agent

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
