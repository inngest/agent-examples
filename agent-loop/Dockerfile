# Connect worker for the goal loop (sandbox backend). Connect is an outbound
# WebSocket, so this needs no public ingress: a Render background worker.
# The worker never executes agent code: typechecking runs here (tsc on a temp
# dir) and the grader runs in a fresh Inngest Sandbox per check.
FROM node:22-slim
WORKDIR /app
RUN corepack enable

# tsx and typescript (devDependencies) are needed at runtime, so install dev
# deps too. --ignore-scripts skips the inngest-cli binary download (local Dev
# Server only); tsx/esbuild and the native tsc ship as optional platform deps.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts

COPY src ./src
COPY check ./check
COPY data ./data
COPY workspace-template ./workspace-template
COPY tsconfig.json ./

ENV WORKSPACE_BACKEND=sandbox
ENV NODE_ENV=production

# RENDER_GIT_COMMIT is provided by Render; used as the app version for Inngest
# rolling deploys unless INNGEST_APP_VERSION is set explicitly.
CMD ["sh", "-c", "INNGEST_APP_VERSION=${INNGEST_APP_VERSION:-$RENDER_GIT_COMMIT} exec node --import @inngest/otel/node --import tsx src/worker.ts"]
