# Деплой на VPS 1 ГБ

Runbook для сервера, на котором уже работают чужие сервисы (в том числе
`amnezia-awg2`). Сборка идёт **локально**, на VPS приезжают готовые образы:
`node` + `tsx` + PostgreSQL на 1 ГБ не должны собирать проект.

Короткий порядок:

1. Восстановить SSH-доступ и снять снимок `docker ps`.
2. Добавить 2 ГБ swap и проверить `docker compose`.
3. Собрать два образа локально и сохранить в `ai-admin-images.tar`.
4. Передать образы, `docker-compose.vps.yml`, `.env` и `db/` на сервер.
5. Загрузить образы, поднять проект `ai-admin`, загрузить базу знаний.
6. Проверить логи, память, `amnezia-awg2` и сценарии в Telegram.

## 0. Доступ

Сначала восстановите доступ к нужному серверу: старый hostname
`ams-1-vm-1kp8` больше не резолвится, а случайные IP не подходят. Возьмите
актуальный IP и ключ в панели провайдера.

```bash
ssh -i <путь-к-ключу> root@<VPS_HOST>
```

Если вход по паролю, вводите пароль только в интерактивном запросе, не
записывайте его в команду или историю.

Проверить сервер:

```bash
hostname
uname -m                 # ожидаем x86_64
free -h                  # ожидаем ~1 ГБ RAM
df -h /                  # нужно хотя бы 2–3 ГБ свободно
```

Если архитектура не `x86_64`, образы нужно собирать под неё.

## 0.1. Границы

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

## 0.2. Снимок состояния

До изменений сохраните список контейнеров, чтобы потом сравнить:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | sort > /root/docker-before.txt
cat /root/docker-before.txt
```

После запуска:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | sort > /root/docker-after.txt
diff -u /root/docker-before.txt /root/docker-after.txt
```

В diff должны появиться только контейнеры `ai-admin-*`. Если пропал
`amnezia-awg2` или другой чужой сервис — остановитесь и разбирайтесь.

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

Проверить, что порты `5432` и `4000` не заняты чужими сервисами:

```bash
ss -lntp | grep -E ':5432|:4000' || true
```

Если порт занят, уберите соответствующую строку `ports:` из
`docker-compose.vps.yml`: бот ходит в БД и mock-CRM по внутренней сети
Compose, наружу эти порты не нужны.

Перед запуском остановите локальный бот (`npm run dev`), иначе Telegram
отдаст `409 Conflict`: один токен не может слушать два процесса.

```bash
cd /opt/ai-admin
docker load -i ai-admin-images.tar
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot up -d
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot ps
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
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot exec bot npm run kb:load
```

Ожидаемо: `Файлов загружено: 4, фрагментов: 19` (число может отличаться,
если менялась `kb/`).

## 6. Проверить

```bash
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot ps
docker stats --no-stream
free -h
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

Логи только нового бота:

```bash
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot logs --tail=100 bot
```

В логах должно быть `Бот запущен`, без `TELEGRAM_BOT_TOKEN не задан`,
`ECONNREFUSED` и ошибок миграций.

Проверить, что токен вообще попал в контейнер, не печатая его:

```bash
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot exec bot \
  sh -lc 'test -n "$TELEGRAM_BOT_TOKEN" && echo token-set || echo token-missing'
```

Проверить сеть до LLM и эмбеддингов (401 — это нормально: ключ не печатаем,
но DNS и HTTPS работают):

```bash
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot exec bot \
  node -e "fetch('https://api.groq.com/openai/v1/models').then(r=>console.log('groq',r.status)).catch(e=>console.error('groq',e.message))"

docker compose -p ai-admin -f docker-compose.vps.yml --profile bot exec bot \
  node -e "fetch('https://api.mistral.ai/v1/models').then(r=>console.log('mistral',r.status)).catch(e=>console.error('mistral',e.message))"
```

Проверить БД и базу знаний:

```bash
docker compose -p ai-admin -f docker-compose.vps.yml exec db \
  psql -U app -d admin -c "select count(*) as kb_chunks from kb_chunks;"

docker compose -p ai-admin -f docker-compose.vps.yml exec db \
  psql -U app -d admin -c "select id, client_name, client_phone, starts_at, status from bookings order by id desc limit 5;"
```

`kb_chunks` должен быть около `19`. В `bookings` до подтверждения клиента
не должно появляться новых строк: запись создаётся только после явного «да».

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

## 8. Типовые ошибки

| Симптом | Что проверить |
|---|---|
| `TELEGRAM_BOT_TOKEN не задан` | `.env` лежит рядом с `docker-compose.vps.yml`; проверка `token-missing` выше. |
| `409 Conflict: terminated by other getUpdates request` | локальный `npm run dev` всё ещё слушает того же бота — остановите его. |
| `ECONNREFUSED db:5432` | `docker compose ... ps`, затем `docker compose ... logs db`; БД ещё не здорова. |
| `ECONNREFUSED mock-crm:4000` | `docker compose ... logs mock-crm`; образ `ai-admin-mock-crm:latest` загружен? |
| `401` / `403` от LLM | неверный или пустой ключ в `.env`; ключ не печатать. |
| `OOMKilled` | `free -h`; swap включён? `docker inspect --format '{{.State.OOMKilled}}' $(docker compose -p ai-admin -f docker-compose.vps.yml --profile bot ps -q bot)`. |
| `no space left on device` | `df -h`; удалять только старые теги `ai-admin-*`, не делать общий prune. |
| Бот молчит, логи чистые | проверьте, что локальный бот остановлен, и напишите `/start` в Telegram. |

Не перезапускайте Docker целиком из-за ошибки одного контейнера: сначала
смотрите `docker compose ... logs` и `docker compose ... ps`.

## 9. Обновление

Повторить шаги 2–4. На сервере сначала сохранить текущий образ как
`previous`, чтобы был откат:

```bash
docker tag ai-admin-bot:latest ai-admin-bot:previous 2>/dev/null || true
docker load -i ai-admin-images.tar
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot up -d bot
```

Проверить, что compose-файл валиден, можно так (секреты не печатаются):

```bash
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot config --quiet
```

`down` без `-v` останавливает только контейнеры проекта `ai-admin` и не
удаляет том с базой. `down -v` удаляет данные — не использовать без
отдельного решения.

## 10. Откат

Если новый бот не поднимается:

```bash
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot logs --tail=200 bot
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot ps
```

Вернуть предыдущий образ:

```bash
docker tag ai-admin-bot:previous ai-admin-bot:latest
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot up -d bot
docker compose -p ai-admin -f docker-compose.vps.yml --profile bot logs --tail=100 bot
```

Не удалять `ai-admin-db` и не делать `down -v`: история записей и база
знаний останутся.
