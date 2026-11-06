# The sandbox image: one container per sandbox ID, created by services/sandboxd.
# Agents, Candidate checks, and code sessions run Bun and git on checkouts under /workspace.
FROM oven/bun:1.3.14-debian

# safe.directory: code sessions chown a checkout to a session UID, and root git commands still
# run in it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*' \
  && mkdir -p /workspace \
  && chown 1000:1000 /workspace

# `bun` is UID 1000 in the base image. sandboxd runs commands as root with a reduced capability set.
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
