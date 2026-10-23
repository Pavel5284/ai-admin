FROM node:22-alpine

WORKDIR /app

# Зависимости отдельным слоем: код меняется чаще, чем package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# tsx нужен в рантайме (проект запускается из TypeScript без сборки),
# поэтому devDependencies не выкидываем.
CMD ["npx", "tsx", "src/channels/telegram.ts"]
