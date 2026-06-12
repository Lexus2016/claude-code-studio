ARG BASE_IMAGE=node:20-bookworm
FROM ${BASE_IMAGE}

RUN apt-get update && apt-get install -y \
    git curl python3 python3-pip build-essential tmux \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json ./
COPY scripts/ ./scripts/
RUN npm install --production

COPY . .

RUN mkdir -p /app/data /app/workspace /app/skills /home/node/.claude \
    && touch /app/config.json \
    && chown -R node:node /app/data /app/workspace /app/skills /home/node/.claude /app/.claude \
    && chown node:node /app/config.json

VOLUME ["/app/data", "/app/workspace", "/app/skills"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV WORKDIR=/app/workspace

USER node

CMD ["node", "server.js"]
