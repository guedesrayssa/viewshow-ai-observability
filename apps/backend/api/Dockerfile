# syntax=docker/dockerfile:1.7
FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const http=require('node:http');const request=http.get('http://127.0.0.1:3000/health',response=>{response.resume();process.exit(response.statusCode===200?0:1)});request.on('error',()=>process.exit(1));request.setTimeout(4000,()=>{request.destroy();process.exit(1)})"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
