FROM node:22-slim

RUN npm install -g @anthropic-ai/claude-code \
 && mkdir -p /work && chown node:node /work

WORKDIR /app
COPY --chown=node:node package.json /app/
RUN npm install --omit=dev && chown -R node:node /app
COPY --chown=node:node queue.mjs runner.mjs PROMPT.md /app/

USER node
ENV WORK_DIR=/work
CMD ["node", "/app/runner.mjs"]
