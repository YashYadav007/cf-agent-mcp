FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /app/data && chown pwuser:pwuser /app/data
COPY --from=build /app/dist ./dist
USER pwuser
EXPOSE 8080
CMD ["npm", "start"]
