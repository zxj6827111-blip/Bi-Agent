FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
# START_MODE: server (Web UI) | monitor (纸面交易监控) | both (同时启动)
ENV START_MODE=monitor

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
COPY README.md ./

RUN mkdir -p /app/data && chmod +x ./deploy/entrypoint.sh

EXPOSE 4173

ENTRYPOINT ["./deploy/entrypoint.sh"]
