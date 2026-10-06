FROM node:24-bookworm-slim
WORKDIR /opt/aether-postgres
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY config.mjs server.mjs ./
USER 10001:10001
ENTRYPOINT ["node", "server.mjs"]
