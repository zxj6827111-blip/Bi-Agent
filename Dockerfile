FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
# START_MODE: server | monitor | radar | both | all
ENV START_MODE=monitor

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
COPY README.md ./

RUN mkdir -p /app/data && chmod +x ./deploy/entrypoint.sh

EXPOSE 4173

ENTRYPOINT ["./deploy/entrypoint.sh"]
