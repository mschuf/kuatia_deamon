# Kuatrix Daemon (NestJS)

`kuatrix-daemon` orquesta OCR para documentos pendientes en Kuatrix.
No procesa OCR directamente: delega en `OCR-KUATRIX`.

## Flujo

1. Scheduler ejecuta cada `OCR_DAEMON_INTERVAL_MINUTES`.
2. Busca pendientes:
   - intenta `public.v_documentos_a_procesar`
   - si la vista no existe, usa `public.lk_documentos` filtrando por `OCR_PENDING_STATUSES` (default: `cargado`)
3. Carga un unico prompt desde `lk_prompts`:
   - ordena por `id DESC`
   - toma el mas nuevo
   - filtra por `active = true`
   - si existen columnas `habilitado` o `enabled`, tambien exige `true`
4. Envia documento a `OCR-KUATRIX` (`POST /ocr/process` multipart).
5. Normaliza respuesta OCR y actualiza dinamicamente `lk_documentos`.
6. Crea socio de negocio en `lk_socios_negocios` si no existe por `sn_ruc`.

## Diferencias con alvia_daemon

- Prompt global: no es por empresa, se usa solo el mas nuevo activo/habilitado.
- Socio y documento usan `sn_ruc` (no `sn_id_fiscal`).
- Cliente OCR adaptado al contrato de `OCR-KUATRIX` (`{ success, result }`).

## Endpoints

- `GET /`
- `GET /daemon/health`
- `POST /daemon/run`

Swagger:

- `http://localhost:<PORT>/api`

## Variables de entorno

```env
# Server
PORT=3010

# PostgreSQL
POSTGRES_HOST=172.19.0.201
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change_me
POSTGRES_DB=KUATRIX_BACK
DB_SCHEMA=public
TYPEORM_LOGGING=false

# OCR-KUATRIX service
KUATRIX_OCR_BASE_URL=http://localhost:3000
KUATRIX_OCR_PROCESS_PATH=/ocr/process
KUATRIX_OCR_TIMEOUT_MS=120000
KUATRIX_OCR_API_TOKEN=

# Daemon behavior
OCR_DAEMON_INTERVAL_MINUTES=5
OCR_DAEMON_BATCH_SIZE=20
OCR_DAEMON_RUN_ON_STARTUP=true
OCR_PENDING_STATUSES=cargado
OCR_DOCUMENT_COLUMNS_CACHE_MS=300000

# Status mapping
OCR_STATUS_PROCESSED=procesado
OCR_STATUS_NO_PROMPT=error
OCR_STATUS_NO_DOCUMENT=error
OCR_STATUS_INCOMPLETE=error
OCR_STATUS_ERROR=error

# Manual run security (optional)
DAEMON_CONTROL_TOKEN=

# Logging
LOG_LEVEL=debug
LOG_TO_FILE=true
LOG_DIR=logs
```

## Run

```bash
npm install
npm run start:dev
```

## Build

```bash
npm run build
```
