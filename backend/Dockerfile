FROM node:24-alpine
WORKDIR /app
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
COPY --chown=node:node backend ./backend
COPY --chown=node:node dist/data.mjs dist/engine.mjs ./dist/
USER node
ENV PORT=8080 DATABASE_PATH=/data/conversa.sqlite
EXPOSE 8080
CMD ["node", "backend/server.mjs"]
