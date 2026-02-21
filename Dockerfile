FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    git curl python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data /app/workspace /app/skills

VOLUME ["/app/data", "/app/workspace", "/app/skills"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV WORKDIR=/app/workspace

CMD ["node", "server.js"]
