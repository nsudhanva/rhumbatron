# sandboxd and the sandbox egress proxy (same image, different command).
FROM oven/bun:1.3.14-debian

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src

USER bun
EXPOSE 7070
CMD ["bun", "src/server.ts"]
