# Pathfinder CLI runner image
# Built on the official Playwright image so all browser binaries + system deps
# are already present.
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install only what we need to build the CLI itself
COPY cli/package.json cli/package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY cli/ ./
RUN npm run build

# Default reports volume
VOLUME ["/app/reports"]

ENTRYPOINT ["node", "dist/index.js"]
CMD ["run", "--help"]
