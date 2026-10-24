# https://hub.docker.com/_/node

# Production dependencies for the target platform (linux/amd64 on Cloud Run).
# Only package*.json goes in, so this layer stays cached until dependencies
# change — under QEMU on an arm64 laptop it is the slowest step by far.
#
# npm runs `node-gyp rebuild` for better-sqlite3 on install. The package ships
# a musl prebuild, so nothing is compiled, but node-gyp still downloads Node's
# headers (and SHASUMS256.txt) just to configure, and a timeout on that
# download failed a deploy. Point it at the headers the image already ships.
FROM node:26-alpine AS deps
WORKDIR /usr/src/app
COPY package*.json ./
ENV npm_config_nodedir=/usr/local
RUN apk add --no-cache python3 make g++ && npm install --omit=dev

# GTFS import runs on the build machine's own platform: the sqlite DB and the
# loki Timetable file are platform-independent, and running node under QEMU
# made the import several times slower. Needs its own native node_modules.
FROM --platform=$BUILDPLATFORM node:26-alpine AS data
WORKDIR /usr/src/app
RUN apk add --no-cache tzdata
ENV TZ=Europe/Kyiv
COPY package*.json ./
ENV npm_config_nodedir=/usr/local
RUN apk add --no-cache python3 make g++ && npm install --omit=dev

COPY . ./

# Declared here, not at the top: every RUN after an ARG is a cache miss when
# its value changes, and `make build` passes a new timestamp each time — that
# re-ran npm install on every deploy.
ARG CACHEBUST=1
RUN echo "$CACHEBUST"

RUN wget -S --spider "https://track.ua-gis.com/gtfs/lviv/static.zip" 2>&1 \
  | grep -i 'Last-Modified:' | sed 's/^ *[Ll]ast-[Mm]odified: *//' > ./last-modified.txt

RUN node ./gtfs-import.ts && node ./scripts/slim-gtfs-db.ts

FROM node:26-alpine

# ENV does not cross a build stage: without this the runtime container ran on
# UTC while the build stage was on Kyiv time. Anything reading a local wall
# clock — the schedule fallback, getTodayServiceIds' day-of-week — was then
# three hours off in summer.
RUN apk add --no-cache tzdata \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV TZ=Europe/Kyiv

WORKDIR /usr/src/app

COPY . ./
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=data /usr/src/app/database/Timetable ./database/Timetable
COPY --from=data /usr/src/app/database/gtfs ./database/gtfs
COPY --from=data /usr/src/app/last-modified.txt ./last-modified.txt

HEALTHCHECK --interval=60s --timeout=15s --start-period=30s --retries=3 CMD wget -q --spider http://localhost:8080/health

# Run the web service on container startup.
# Same flags as `npm start`, without an npm process sitting in front of node
# (extra RSS, and it gets SIGTERM instead of the app). Keep in sync with
# package.json "start".
CMD [ "node", "-r", "dotenv/config", "-r", "newrelic", "--import", "newrelic/esm-loader.mjs", "index.ts" ]
