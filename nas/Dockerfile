FROM node:22-slim

RUN npm install -g @anthropic-ai/claude-code \
 && mkdir -p /work && chown node:node /work

# 라이브러리만 이미지에 넣는다. 코드는 /app/src 에 폴더째 연결해서 쓴다(docker-compose.yml).
# 이러면 코드를 고쳤을 때 이미지를 다시 만들 필요 없이 **컨테이너만 다시 시작**하면 된다.
# (node 는 /app/src 에서 못 찾은 모듈을 /app/node_modules 에서 찾으므로 그대로 돈다)
WORKDIR /app
COPY --chown=node:node package.json /app/
RUN npm install --omit=dev && chown -R node:node /app

USER node
ENV WORK_DIR=/work
CMD ["node", "/app/src/runner.mjs"]
