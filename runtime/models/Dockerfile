FROM node:24-bookworm-slim
WORKDIR /opt/aether-models
COPY package.json config.mjs server.mjs ./
USER 10001:10001
CMD ["node", "server.mjs"]
