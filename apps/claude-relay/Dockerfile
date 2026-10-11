FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /app
COPY server.js .
USER node
ENV HOME=/home/node PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
