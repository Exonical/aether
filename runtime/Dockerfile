# Build with: docker build -f runtime/Dockerfile -t aether-runtime:0.1.0 runtime
FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 aether \
    && useradd --uid 10001 --gid aether --no-create-home aether \
    && mkdir -p /var/lib/aether /opt/aether \
    && chown aether:aether /var/lib/aether
COPY --from=build /build/node_modules/workerd/bin/workerd /usr/local/bin/workerd
COPY aether.capnp /opt/aether/aether.capnp
COPY src/ /opt/aether/src/
USER 10001:10001
WORKDIR /opt/aether
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/workerd"]
CMD ["serve", "/opt/aether/aether.capnp", "--experimental", "--socket-addr=http=0.0.0.0:8080", "--directory-path=state=/var/lib/aether"]
