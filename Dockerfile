FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY public/ ./public/
COPY admin/ ./admin/
ENV NODE_ENV=production PUBLIC_DIR=/app/public ADMIN_DIR=/app/admin
VOLUME ["/app/storage"]
EXPOSE 8080
CMD ["npm","start"]