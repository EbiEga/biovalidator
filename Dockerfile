FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS build

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY scripts ./scripts
COPY src ./src
COPY media ./media

RUN npm run build:ui \
    && npm prune --omit=dev

FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS runtime

ARG REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/EbiEga/biovalidator" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.title="Biovalidator"

WORKDIR /usr/src/app

COPY --from=build --chown=node:node /usr/src/app/package.json ./package.json
COPY --from=build --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/src/biovalidator.js ./src/biovalidator.js
COPY --from=build --chown=node:node /usr/src/app/src/core ./src/core
COPY --from=build --chown=node:node /usr/src/app/src/keywords ./src/keywords
COPY --from=build --chown=node:node /usr/src/app/src/model ./src/model
COPY --from=build --chown=node:node /usr/src/app/src/utils ./src/utils
COPY --from=build --chown=node:node /usr/src/app/src/views ./src/views

ENV NODE_ENV=production \
    BIOVALIDATOR_PORT=3020 \
    BIOVALIDATOR_LOG_DIR=/tmp/biovalidator/logs \
    BIOVALIDATOR_PID_PATH=/tmp/biovalidator/server.pid

USER node

EXPOSE 3020

ENTRYPOINT ["node", "src/biovalidator.js"]
