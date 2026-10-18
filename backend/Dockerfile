FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
WORKDIR /app
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
COPY --chown=node:node backend ./backend
COPY --chown=node:node dist/data.mjs dist/engine.mjs dist/live-panel.mjs dist/publications.mjs dist/notifications.mjs ./dist/
USER node
ENV PORT=8080 DATABASE_PATH=/data/conversa.sqlite
EXPOSE 8080
CMD ["node", "backend/server.mjs"]
