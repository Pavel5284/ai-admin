# Деплой на VPS 1 ГБ

Runbook для сервера, на котором уже работают чужие сервисы (в том числе
`amnezia-awg2`). Сборка идёт **локально**, на VPS приезжают готовые образы:
`node` + `tsx` + PostgreSQL на 1 ГБ не должны собирать проект.

## 0. Границы

- Не перезапускать Docker и не менять `/etc/docker/daemon.json`.
- Не трогать `amnezia-awg2`, `fwupd`, `multipathd`, `unattended-upgrades`,
  `systemd-journald`.
- Не запускать на VPS `npm test` и `npm run eval`.
- Не делать `docker system prune`, `docker volume prune`, `docker compose down -v`.
- Секреты живут только в `.env` на сервере; в git и в чат их не копировать.

Перед началом и после каждого шага:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
free -h
```

`amnezia-awg2` должен оставаться `Up`.

## 1. Подготовить сервер

Проверить, что есть `docker compose`:

```bash
docker compose version
```

Если команда неизвестна, поставить плагин (Docker при этом не перезапускается):

```bash
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
docker compose version
```

Если пакета нет в репозитории:

```bash
sudo apt-get install -y docker-compose-v2
docker compose version
```

Запасной вариант — плагин вручную:

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL \
  https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

Добавить 2 ГБ swap, если его нет:

```bash
free -h
swapon --show
```

Если `swapon --show` пуст:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || \
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Если `fallocate` не сработал:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## 2. Собрать образы локально

Docker Desktop должен быть запущен. Из корня проекта:

```powershell
docker build --platform linux/amd64 -t ai-admin-bot:latest .
docker build --platform linux/amd64 -t ai-admin-mock-crm:latest .\mock-crm
docker save ai-admin-bot:latest ai-admin-mock-crm:latest -o ai-admin-images.tar
```

Проверить, что в образе свежий код:

```powershell
docker run --rm ai-admin-bot:latest node -e "console.log('image ok')"
```

## 3. Передать файлы

На сервере:

```bash
mkdir -p /opt/ai-admin
```

Локально (подставить свой хост и ключ, если он нужен):

```powershell
scp -i $HOME\.ssh\<KEY> .\ai-admin-images.tar .\docker-compose.vps.yml .\.env root@<VPS_HOST>:/opt/ai-admin/
scp -i $HOME\.ssh\<KEY> -r .\db root@<VPS_HOST>:/opt/ai-admin/
```

`.env` должен содержать рабочие `TELEGRAM_BOT_TOKEN`, `LLM_*`, `EMBED_*`.
Проверять его содержимое в терминале и в логах нельзя.

## 4. Загрузить образы и запустить

```bash
cd /opt/ai-admin
docker load -i ai-admin-images.tar
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot up -d
docker compose -p ai-admin -f docker-compose.vps.yml ps
```

Если на сервере уже был проект `ai-admin`, сначала посмотреть его контейнеры,
но не удалять их автоматически:

```bash
docker ps -a --filter label=com.docker.compose.project=ai-admin
```

## 5. Загрузить базу знаний

Один раз после первого запуска БД:

```bash
cd /opt/ai-admin
docker compose -p ai-admin -f docker-compose.vps.yml exec bot npm run kb:load
```

Ожидаемо: `Файлов загружено: 4, фрагментов: 19` (число может отличаться,
если менялась `kb/`).

## 6. Проверить

```bash
docker compose -p ai-admin -f docker-compose.vps.yml ps
docker stats --no-stream
free -h
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

Логи только нового бота:

```bash
docker compose -p ai-admin -f docker-compose.vps.yml logs --tail=100 bot
```

В логах должно быть `Бот запущен`, без `TELEGRAM_BOT_TOKEN не задан`,
`ECONNREFUSED` и ошибок миграций.

## 7. Проверка в Telegram

1. Полная запись: услуга, дата, время, телефон, имя, явное «да».
2. Неполный телефон: бот просит назвать номер целиком, не говорит
   «Записал N цифр».
3. Слишком длинный телефон: бот просит повторить номер, не зацикливается.
4. `13 диана` в контексте записи: бот не путает число с временем.
5. Вопрос без ответа в базе: бот останавливает запись, просит телефон
   и создаёт задачу администратору.
6. Жалоба или просьба позвать администратора: бот не продолжает запись,
   просит контакт.
7. Имя `иван` отображается как `Иван`.

## 8. Обновление

Повторить шаги 2–4. Перед `up -d` можно посмотреть diff:

```bash
docker compose -p ai-admin -f docker-compose.vps.yml config --quiet
```

`down` без `-v` останавливает только контейнеры проекта `ai-admin` и не
удаляет том с базой. `down -v` удаляет данные — не использовать без
отдельного решения.

## 9. Откат

Если новый бот не поднимается:

```bash
docker compose -p ai-admin -f docker-compose.vps.yml logs --tail=200 bot
docker compose -p ai-admin -f docker-compose.vps.yml ps
```

Вернуть предыдущий образ можно, пересобрав/загрузив старый тег и выполнив
`up -d` с тем же compose-файлом. Не удалять `ai-admin-db` и не делать
`down -v`: история записей и база знаний останутся.
