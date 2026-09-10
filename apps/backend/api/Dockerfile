# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY contracts/package.json contracts/package.json
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.workspaces.json tsconfig.base.json ./
COPY src ./src
COPY contracts ./contracts
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init=1.2.5-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/contracts/package.json ./contracts/package.json
COPY --from=build --chown=node:node /app/contracts/dist ./contracts/dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const http=require('node:http');const request=http.get('http://127.0.0.1:3000/health',response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>process.exit(response.statusCode===200&&body==='{\\\"status\\\":\\\"ok\\\"}'?0:1))});request.on('error',()=>process.exit(1));request.setTimeout(4000,()=>{request.destroy();process.exit(1)})"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
