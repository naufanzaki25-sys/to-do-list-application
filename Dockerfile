FROM node:20-slim

WORKDIR /app

# Salin package.json & pasang modul
COPY package*.json ./
RUN npm install --omit=dev

# Salin seluruh kode program
COPY . .

# Buat direktori sesi dengan izin penuh
RUN mkdir -p /app/auth_info_baileys && chmod -R 777 /app/auth_info_baileys

# Port bawaan Hugging Face Spaces
ENV PORT=7860
EXPOSE 7860

CMD ["node", "bot.js"]
