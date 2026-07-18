FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    AGENT_BUS_ROOT=/data \
    AGENT_BUS_HOST=127.0.0.1 \
    AGENT_BUS_PORT=8091 \
    AGENT_BUS_LOG_DIR=/logs

RUN mkdir -p /data /logs && chown -R node:node /app /data /logs
USER node
EXPOSE 8091

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8091/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/control-plane/server.mjs"]
