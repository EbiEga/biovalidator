FROM node:26-alpine3.22@sha256:c7932b9e5e337b0e733d6e16abc1b0e104759e8b05e59ed56586cce967d26dfe AS build

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY scripts ./scripts
COPY src ./src
COPY media ./media

RUN npm run build:ui \
    && npm prune --omit=dev

FROM node:26-alpine3.22@sha256:c7932b9e5e337b0e733d6e16abc1b0e104759e8b05e59ed56586cce967d26dfe AS runtime

ARG REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/EbiEga/biovalidator" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.title="Biovalidator"

WORKDIR /usr/src/app

# Keep runtime packages current, and remove npm because it is required only by the
# build stage and is not needed to run the production image.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build --chown=node:node /usr/src/app/package.json ./package.json
COPY --from=build --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/src/biovalidator.js ./src/biovalidator.js
COPY --from=build --chown=node:node /usr/src/app/src/core ./src/core
COPY --from=build --chown=node:node /usr/src/app/src/keywords ./src/keywords
COPY --from=build --chown=node:node /usr/src/app/src/model ./src/model
COPY --from=build --chown=node:node /usr/src/app/src/utils ./src/utils
COPY --from=build --chown=node:node /usr/src/app/src/views ./src/views

ENV NODE_ENV=production \
    BIOVALIDATOR_REVISION=${REVISION} \
    BIOVALIDATOR_FILE_LOG_ENABLED=false \
    BIOVALIDATOR_PORT=3020 \
    BIOVALIDATOR_LOG_DIR=/tmp/biovalidator/logs \
    BIOVALIDATOR_PID_PATH=/tmp/biovalidator/server.pid

USER node

EXPOSE 3020

ENTRYPOINT ["node", "src/biovalidator.js"]
