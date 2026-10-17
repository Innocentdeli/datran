# Next.js app (diocom-app). Build context is the repository root because the app imports
# shared TypeScript from ../src (ACSNode, DiocomReactor) which uses the root dependencies.
FROM node:22-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY diocom-app/package.json diocom-app/package-lock.json ./diocom-app/
RUN cd diocom-app && npm ci

COPY tsconfig.json ./
COPY src ./src
COPY diocom-app ./diocom-app
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd diocom-app && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /repo
RUN useradd -r -u 10001 -d /repo app && mkdir -p /data/app && chown app /data/app
COPY --from=build --chown=app /repo /repo
USER app
WORKDIR /repo/diocom-app
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/next start -H \"$HOSTNAME\" -p \"$PORT\""]
