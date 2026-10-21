# function-state-server

HTTP-сервис состояний и функций для `processor`. Состояния и вызовы подключаются через MQTT и YAML-конфигурацию.

## Docker Compose

```bash
cp config.example.yaml config.yaml
# отредактируйте config.yaml и задайте MQTT_URL
docker compose build function-state-server
docker compose up -d function-state-server
curl http://localhost:8081/functions
```

Standalone: `docker build -t function-state-server . && docker run --rm -p 8081:8080 -v "$PWD/config.yaml:/app/config.yaml:ro" -v "$PWD/ca-cert.pem:/app/ca-cert.pem:ro" -e PORT=8080 function-state-server`.

В общем Compose внутренний порт — `8080`; внешний пример использует `8081`.

## Переменные

- `PORT` (default `8080`)
- `MQTT_URL` — MQTT/MQTTS broker
- `MQTT_CA_CERTIFICATE_PATH` (default `ca-cert.pem`)
- `CONFIG_PATH` (default `config.yaml`)

Endpoints: `GET /functions`, `PATCH /functions`, `POST /state`, `PUT /state`. `/health` отсутствует. Текущий `config.yaml` пустой, поэтому для функций нужно использовать и адаптировать `config.example.yaml`. Не коммитьте `.env`, пароли и приватные сертификаты.
