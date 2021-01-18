# Use the official lightweight Node.js 12 image.
# https://hub.docker.com/_/node
FROM node:12-alpine AS BUILD_IMAGE

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
# Copying this separately prevents re-running npm install on every code change.
COPY package*.json ./

# Install production dependencies.
RUN npm install --only=production

# Copy local code to the container image.
COPY . ./

RUN echo "$CACHEBUST"

RUN apk --no-cache add curl && curl --silent --head "http://track.ua-gis.com/gtfs/lviv/static.zip" | grep 'Last-Modified:' | cut -c 16- > ./last-modified.txt

RUN node ./gtfs-import.js

FROM node:12-alpine

WORKDIR /usr/src/app

COPY . ./
COPY --from=BUILD_IMAGE /usr/src/app/node_modules ./node_modules
COPY --from=BUILD_IMAGE /usr/src/app/database/Timetable ./database/Timetable
COPY --from=BUILD_IMAGE /usr/src/app/last-modified.txt ./last-modified.txt

RUN node ./gtfs-import-slim.js

# Run the web service on container startup.
CMD [ "npm", "start" ]