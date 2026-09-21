# Imagem oficial do Playwright já traz Chromium + dependências do SO,
# evitando o apt-get manual (fonte comum de imagem quebrada em prod).
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV HEADLESS=true

EXPOSE 8787

CMD ["node", "src/index.js"]
