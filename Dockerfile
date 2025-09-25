FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
    chromium ca-certificates fonts-liberation \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node","index.js"]
