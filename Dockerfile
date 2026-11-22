# The Docker sandbox the agent runs in when started with --sandbox (see the README).
# It has Node, npm and git, and the project is mounted at /workspace. The OpenRouter key isn't
# part of the image: it is passed in from the agent's .env when the container starts.
FROM node:24-slim

# The project comes from the host, so its owner may not be the container's user: let git work
# on it anyway. HOME and node_modules (the mount point of the project's own node_modules
# volume) are writable by any user, since on Linux the container runs as the host user.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 && mkdir -p /home/agent /workspace/node_modules \
 && chmod 1777 /home/agent /workspace/node_modules

WORKDIR /opt/phi-agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm
COPY agent.mjs ./
COPY src ./src

ENV HOME=/home/agent PHI_AGENT_SANDBOX=1
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/phi-agent/agent.mjs"]
