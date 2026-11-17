# openpad

Clone self-hosted do [dontpad.com](https://dontpad.com): qualquer URL é uma página de texto partilhada, sem login, com gravação automática e sincronização entre browsers. Arranca com um único `docker compose up` e guarda tudo num ficheiro SQLite.

Implementação da especificação técnica "Clone do Dontpad: especificação técnica completa (Docker)". Replica-se o comportamento do original, não o código nem a marca.

## Arranque rápido

Requisitos: Docker com o plugin Compose.

```bash
git clone https://github.com/joaoribeiiro15/Dontpad-Docker.git
cd Dontpad-Docker
docker compose up -d --build
```

Abre `http://localhost:3000`, escreve um nome e carrega em **Go!**. Partilha a ligação: quem a abrir vê e edita o mesmo texto.

```bash
docker compose logs -f openpad      # ver logs
docker compose down                 # parar, os dados ficam no volume openpad-data
```

## Como funciona

- **Uma página por caminho.** `/reuniao`, `/equipa/notas/2026`: qualquer caminho válido abre uma página, criada ao escrever nela. Uma página vazia não é guardada.
- **Subpáginas.** `/pai/filho` é uma página independente. A página mãe mostra um menu lateral com as subpáginas diretas, por ordem alfabética, e uma ligação para descarregar tudo em `.zip`.
- **Sincronização por polling, como no original.** Um relógio de 100 ms no browser faz no máximo um pedido a cada 5 s, nunca dois ao mesmo tempo. Se há alterações locais grava (`POST`), senão pergunta se a página mudou (`GET`). Com o separador em segundo plano não faz pedidos.
- **Controlo de concorrência otimista.** O servidor gera um `lastModified` a cada gravação. Uma gravação feita sobre uma versão antiga recebe `409 update-timestamp-mismatch` e o browser mostra um modal: **Substituir** grava por cima, **Descartar** troca o texto local pelo do servidor.
- **Indicador de estado** no canto superior direito: a gravar, gravado (2 s, fundo verde) e erro com nova tentativa a cada ciclo.
- A tecla **Tab** insere uma tabulação, e o browser avisa ao sair da página com texto por gravar.

Uma alteração chega aos outros browsers em 10 s no pior caso: 5 s para gravar e 5 s para o outro perguntar.

## Configuração

Todas as variáveis são opcionais. Com o Compose, copia `.env.example` para `.env` e muda o que precisares.

| Variável | Omissão | Função |
| --- | --- | --- |
| `HOST_PORT` | `3000` | Porto publicado no host (só no Compose) |
| `PORT` | `3000` | Porto HTTP dentro do contentor |
| `APP_NAME` | `openpad` | Nome na página inicial e no título dos separadores |
| `DB_PATH` | `/data/openpad.db` | Ficheiro SQLite |
| `SYNC_INTERVAL_MS` | `5000` | Intervalo do ciclo de sincronização, entregue ao browser |
| `REQUEST_TIMEOUT_MS` | `10000` | Timeout dos pedidos no browser |
| `MAX_BODY_BYTES` | `1048576` | Tamanho máximo do texto de uma página, em bytes UTF-8 |
| `MAX_DEPTH` | `10` | Níveis máximos de subpáginas |
| `RATE_LIMIT_PER_MIN` | `120` | Pedidos à API por IP e por minuto |
| `TRUST_PROXY` | `false` | Ler o IP de `X-Forwarded-For` quando há proxy inverso |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error` |

Com o intervalo de 5 s, cada separador aberto faz cerca de 12 pedidos por minuto. O limite de 120 por IP chega para 10 separadores atrás do mesmo endereço.

## Expor à Internet

Coloca um proxy inverso com TLS à frente do porto 3000 e define `TRUST_PROXY=true`, para o limite de pedidos usar o IP real de cada cliente. Não é preciso suporte a WebSockets. Exemplo com Caddy:

```
notas.exemplo.pt {
	reverse_proxy localhost:3000
}
```

## API

A API vive na mesma origem, sob `/api`. Todas as respostas levam `Cache-Control: no-store`.

| Método e rota | Função | Resposta |
| --- | --- | --- |
| `GET /api/body/<caminho>?lastModified=<n>` | Ler o texto se mudou desde `n` | `{"changed": false, "lastModified": n}` ou `{"changed": true, "lastModified": m, "body": "..."}` |
| `POST /api/body/<caminho>` | Gravar `text`, `lastModified` e `force` em `x-www-form-urlencoded` | O novo `lastModified` como número JSON |
| `GET /api/menu/<caminho>` | Subpáginas diretas | `["compras", "reuniao"]`, sem ordem garantida |
| `GET /api/zip/<caminho>` | Página e subpáginas, um `.txt` por página | `application/zip` |
| `GET /api/config` | Configuração do browser | `{"appName", "syncIntervalMs", "requestTimeoutMs", "maxBodyBytes"}` |
| `GET /healthz` | Verificação de saúde | `{"status": "ok"}` |

Erros ao gravar:

| Situação | Código | Corpo |
| --- | --- | --- |
| `lastModified` diferente do servidor e `force=false` | 409 | `{"error":"update-timestamp-mismatch"}` |
| Texto acima de `MAX_BODY_BYTES` | 413 | `{"error":"body-too-large"}` |
| Caminho com demasiados níveis | 400 | `{"error":"nesting-limit-reached"}` |
| Caminho inválido ou reservado | 400 | `{"error":"invalid-path"}` |
| Limite de pedidos excedido | 429 | `{"error":"rate-limited"}` |

Exemplo:

```bash
curl "http://localhost:3000/api/body/reuniao?lastModified=0"
curl -X POST --data-urlencode "text@notas.txt" -d lastModified=0 -d force=true http://localhost:3000/api/body/reuniao
```

### Regras de caminho

- O caminho é o pathname do URL descodificado, sem barra final e com barras duplicadas colapsadas.
- Distingue maiúsculas de minúsculas.
- Máximo de 255 caracteres e de `MAX_DEPTH` segmentos.
- Os primeiros segmentos `api`, `assets`, `healthz` e `robots.txt` estão reservados.
- São rejeitados os segmentos `.` e `..` e os caracteres de controlo.

## Cópias de segurança

Cópia consistente com o serviço a correr:

```bash
docker compose exec openpad node -e "require('better-sqlite3')('/data/openpad.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp openpad:/data/backup.db ./backup.db
```

Para restaurar: `docker compose down`, copia o ficheiro para o volume como `openpad.db` e volta a arrancar.

## Segurança

Tal como no original, quem conhece o URL lê e escreve: o nome da página é o único segredo. Usa nomes difíceis de adivinhar. As medidas abaixo protegem o serviço, não o conteúdo.

- O texto só entra no DOM por `textarea.value` e `textContent`, nunca por `innerHTML`.
- Só prepared statements com parâmetros.
- Limite de pedidos por IP na API, com resposta 429. O browser duplica o intervalo até 60 s e volta ao normal após um sucesso.
- Limite de tamanho por página e limite do corpo do pedido no servidor.
- Cabeçalhos `Content-Security-Policy: default-src 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e `X-Frame-Options: DENY`.
- `robots.txt` a bloquear tudo e `X-Robots-Tag: noindex` nas páginas de edição e na API.
- O processo corre como utilizador `node`. No Compose, o sistema de ficheiros do contentor é só de leitura fora de `/data` e `/tmp`, sem capabilities.
- Os logs registam método, rota normalizada, código e duração. Nunca registam o caminho nem o texto das páginas.

## Desenvolvimento

Requer Node.js 22.2 ou mais recente.

```bash
npm install
npm run dev                      # http://localhost:3000, base de dados em ./data/openpad.db
npm test                         # unitários e API (node --test, fastify.inject)
npx playwright install chromium  # uma vez
npm run test:e2e                 # ponta a ponta, CA-01 a CA-08, CA-10 e extras
```

Por omissão, os testes ponta a ponta arrancam um servidor local com um ciclo de 1 s para correrem depressa. Para os correr com o ciclo real ou contra o contentor:

```bash
SYNC_INTERVAL_MS=5000 npm run test:e2e
BASE_URL=http://localhost:3000 npm run test:e2e
```

Estrutura:

```
src/
  server.js        arranque e encerramento limpo
  app.js           montagem do Fastify, cabeçalhos, logs, erros
  config.js        variáveis de ambiente
  paths.js         normalização e validação de caminhos, regra de lastModified
  db.js            SQLite (WAL), esquema, prepared statements, consulta do menu
  zip.js           escritor de .zip sem dependências
  routes/api.js    body, menu, config, zip, limite de pedidos
  routes/pages.js  index.html, pad.html, robots.txt, healthz
public/
  index.html, pad.html
  assets/          home.css, pad.css, home.js, pad.js, icons/
test/
  paths.test.js, db.test.js, api.test.js
  e2e/sync.spec.js
```

O workflow em `.github/workflows/ci.yml` corre os testes unitários, de API e ponta a ponta. Depois constrói a imagem, faz um teste de fumo ao `/healthz` e publica em `ghcr.io/joaoribeiiro15/dontpad-docker` em cada push para `main`.

## Licença

MIT.
