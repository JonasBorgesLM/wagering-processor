# The tag says which version; the digest makes it that exact image, since a tag can be moved (NFR-10).
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
