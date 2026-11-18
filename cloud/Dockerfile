# Infoflex Cloud — the licence server and vendor portal, as one small image.
#
#   docker build -f cloud/Dockerfile -t infoflex-cloud .
#   docker run -d --name infoflex-cloud --env-file cloud/.env -p 8080:8080 \
#     -v infoflex-cloud-data:/data -v /srv/keys:/keys:ro infoflex-cloud
#
# The image contains no secret: the signing key and session secret arrive at run time from the environment or
# from files on a mounted volume.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# argon2 and better-sqlite3 are native modules; the build stage has the toolchain they need.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false
COPY tsconfig.json ./
COPY src ./src
COPY cloud ./cloud
# The cloud runs through tsx in the image, which keeps one source of truth for the code we tested.

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app infoflex \
    && mkdir -p /data/backups /keys && chown -R infoflex:infoflex /data /keys
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/cloud ./cloud
USER infoflex
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "cloud/src/server.ts"]
