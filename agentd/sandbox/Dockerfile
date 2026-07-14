# kiln-agent — the sandbox template image (§5.2). One instance per session,
# created by sandboxd inside a microVM. Rebuild + retag whenever the SDK pin
# changes; agentd refuses new sessions if the tag it expects is absent.
#
#   docker build -t kiln-agent:0.1.0 agentd/sandbox
#
FROM node:22-bookworm-slim

# git + gh + everyday tooling for a coding agent
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq ripgrep procps \
    build-essential python3 \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Pinned Agent SDK (vendors the Claude Code runtime). The shim resolves it
# from /opt/kiln/node_modules. Bump deliberately; validate the shim's option
# names against docs.claude.com when you do (§5.4 pin-and-verify).
WORKDIR /opt/kiln
RUN npm init -y >/dev/null \
  && npm install --no-audit --no-fund @anthropic-ai/claude-agent-sdk@0.3.209

COPY agent-shim.mjs bootstrap.sh finalise.sh checkpoint.sh /opt/kiln/
RUN chmod 0755 /opt/kiln/*.sh /opt/kiln/agent-shim.mjs

# non-root agent user; workspace mounted at /work by sandboxd
RUN useradd -m -u 1001 -s /bin/bash agent \
  && mkdir -p /work \
  && chown -R agent:agent /work /opt/kiln
USER agent
ENV HOME=/home/agent
WORKDIR /work

# the sandbox stays alive for execs; agentd drives everything through them
CMD ["sleep", "infinity"]
