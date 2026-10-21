# function-state-server

HTTP state and function service for `processor`. Providers are configured in YAML and can read or publish through MQTT.

## Docker Compose

```bash
cp config.example.yaml config.yaml
# Edit config.yaml and set MQTT_URL
docker compose build function-state-server
docker compose up -d function-state-server
curl http://localhost:8081/functions
```

Standalone: `docker build -t function-state-server . && docker run --rm -p 8081:8080 -v "$PWD/config.yaml:/app/config.yaml:ro" -v "$PWD/ca-cert.pem:/app/ca-cert.pem:ro" -e PORT=8080 function-state-server`.

Inside the shared Compose network the container listens on `8080`; `8081` is only an example host mapping.

## Environment

- `PORT` (default `8080`)
- `MQTT_URL` - MQTT or MQTTS broker URL
- `MQTT_CA_CERTIFICATE_PATH` (default `ca-cert.pem`)
- `CONFIG_PATH` (default `config.yaml`)

Endpoints: `GET /functions`, `PATCH /functions`, `POST /state`, and `PUT /state`. There is no `/health` endpoint. The default `config.yaml` is empty, so adapt `config.example.yaml` to expose functions and states. Never commit credentials or private certificates.
