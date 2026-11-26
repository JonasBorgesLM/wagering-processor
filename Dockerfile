# The tag says which version; the digest makes it that exact image, since a tag can be moved (NFR-10).
FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b
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
