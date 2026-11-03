# The image of the goal's work sandbox (src/sandboxes.ts, `semver-coder:v1`):
# node for the model's shell, tsc for the typecheck after every edit, git for
# the attempts' commits, and `snapshot` to hand an attempt's code back.
FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g typescript@7
COPY snapshot.js /usr/local/bin/snapshot
RUN chmod +x /usr/local/bin/snapshot
WORKDIR /work
