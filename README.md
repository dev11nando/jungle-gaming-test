# Jungle Gaming — processador de apostas

Serviço financeiro distribuído que processa transações de aposta de vários provedores, por HTTP e SQS, com correção sob duplicação, reordenação, falhas e múltiplas instâncias. NestJS no Bun, PostgreSQL (MikroORM), SQS no LocalStack e Keycloak. Decisões e trade-offs em [ARCHITECTURE.md](ARCHITECTURE.md); fases e mapa dos cenários obrigatórios em [docs/ROADMAP.md](docs/ROADMAP.md); carga em [docs/load-test.md](docs/load-test.md).

## Endpoints

| Método | Caminho | Auth |
| --- | --- | --- |
| `GET` | `/health/live` | aberta |
| `GET` | `/health/ready` | aberta — exige Postgres e SQS (Keycloak informativo) |
| `GET` | `/metrics` | aberta — formato Prometheus |
| `POST` | `/wallets` | Bearer JWT |
| `GET` | `/wallets/:walletId` | Bearer JWT |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | Bearer JWT |
| `POST` | `/wallets/:walletId/reconciliation` | Bearer JWT |
| `POST` | `/wagering/transactions` (header `Idempotency-Key`) | Bearer JWT, `provider_id` = `providerId` do corpo |
| `GET` | `/wagering/transactions/:transactionId` | Bearer JWT (só do próprio provedor) |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Bearer JWT do mesmo provedor |
| `GET` | `/whoami` | Bearer JWT do realm `jungle` |

Mapa de status (igual em todos os endpoints): 400 contrato · 401/403 auth · 404 ausente · 409 conflito · 422 rejeição de negócio persistida · 200 processada/replay · 202 pendente · 503 transitório (reenviar com a mesma key). Detalhes em [ARCHITECTURE.md § HTTP](ARCHITECTURE.md#http).

### Exemplo

```bash
TOKEN=$(curl -s -X POST "http://localhost:8080/realms/jungle/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).access_token)')

curl -s -X POST localhost:3000/wallets -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker Compose v2 (Docker Desktop com WSL2)
- Portas livres: `3000` (API), `5432` (Postgres), `4566` (LocalStack), `8080` (Keycloak)

## Início rápido

Com o Docker rodando:

```bash
bun run setup
```

O script (`setup/setup.ts`) confere os pré-requisitos, cria o `.env` a partir do `.env.example` se não existir, instala as dependências, sobe PostgreSQL, LocalStack e Keycloak, espera todos ficarem healthy, roda as migrations, constrói e sobe a API no Docker e só termina quando `/health/ready` responde 200. Na primeira vez leva alguns minutos por causa do download das imagens.

| Comando | Efeito |
| --- | --- |
| `bun run setup` | sobe tudo (infra + migrations + API com todos os workers) |
| `bun run setup --infra` | sobe só a infra e roda as migrations, para rodar a API no host com `bun run start:dev` |
| `bun run stop` | para todos os containers, mantendo containers e dados; `bun run setup` volta de onde parou |
| `bun run down` | remove containers e rede; os dados do PostgreSQL ficam no volume |
| `bun run down --volumes` | remove também os dados; o próximo setup recria banco e realm do zero |

Os scripts são TypeScript rodando no Bun, então funcionam igual em Windows, Linux e macOS.

### Passo a passo manual

```bash
cp .env.example .env
bun install
bun run stack:up          # Postgres, LocalStack e Keycloak
bun run db:migrate
bun run start:dev         # API no host; ou bun run stack:app para a API no Compose
```

O Postgres só roda `docker/postgres/init.sql` na primeira criação do volume, e o realm do Keycloak fica salvo no banco dele.

## Token de provedor

O realm `jungle` já vem importado. O client de exemplo `provider-a` é confidential, com service account, claim fixo `provider_id=provider-a` e audience `wagering-api`. Segredo local, só para desenvolvimento: `provider-a-secret`.

```bash
curl -s -X POST "http://localhost:8080/realms/jungle/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=provider-a" \
  -d "client_secret=provider-a-secret"
```

```bash
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
curl -s http://localhost:3000/whoami
curl -s http://localhost:3000/whoami -H "Authorization: Bearer $TOKEN"
```

Sem token, `/whoami` responde 401. Com token válido, 200. Health não pede autenticação.

Console do Keycloak: `http://localhost:8080` com `admin` / `admin`.

## Comandos

| Comando | Efeito |
| --- | --- |
| `bun run setup` / `stop` / `down` | sobe, para ou remove o ambiente inteiro (ver Início rápido) |
| `bun run start` | sobe a API |
| `bun run start:dev` | sobe a API e recarrega ao salvar |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run test` | testes unitários do domínio (sem infra) |
| `bun run test:integration` | constraints, casos de uso, concorrência, consumidor SQS, outbox e pendências contra PostgreSQL e LocalStack reais (banco `wagering_test` e filas por teste criados automaticamente; requer `stack:up`) |
| `bun run test:e2e` | API HTTP completa (guard real com chave JWT local) contra PostgreSQL real |
| `bun run test:cluster` | 3 processos reais da aplicação (HTTP + workers) contra PostgreSQL e LocalStack, com SIGKILL e reinício |
| `bun run test:all` | todos os testes acima |
| `bun run test:load` | teste de carga com 3 instâncias; gera `docs/load-test-results.md` ([metodologia e análise](docs/load-test.md)) |
| `bun run db:migrate` | aplica migrations pendentes |
| `bun run db:migrate:down` | reverte a última migration |
| `bun run db:migrate:status` | migrations executadas e pendentes |
| `bun run stack:up` | Postgres, LocalStack e Keycloak |
| `bun run stack:app` | o mesmo, mais a API no Compose |
| `bun run stack:down` | derruba a stack |

## Layout

Clean Architecture simplificada: o domínio no centro, sem dependência de framework; os adapters implementam os contratos do domínio; o `main/` monta tudo. Detalhes em [ARCHITECTURE.md § Camadas](ARCHITECTURE.md#camadas).

```text
src/
  domain/
    entities/        Money, Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage
    events/          IntegrationEvent e os 4 eventos
    services/        processWager (regras de BET/WIN/LOSS/REFUND/ROLLBACK), payload hash
    errors/          erros de domínio e de aplicação
    contracts/       interfaces + tokens: repositórios, UnitOfWork, Clock, IdGenerator, Metrics, Logger, ProviderIdentityPort
    usecases/        OpenWallet, SubmitWagerTransaction, WalletQueries, ReconcileWallet, ProcessPendingReferences, HandleWagerMessage
  infra/             adapters que implementam os contratos
    database/        MikroORM (EntitySchema), repositórios, migrations, CLI de migração
    messaging/       consumidor SQS, publisher da outbox, loop de workers
    auth/            guard OIDC (Keycloak), @Public()
    observability/   logger JSON, métricas Prometheus
    config/ health/ system/
  presentation/http/ controllers, filtro de erros, presenters, correlation id
  main/              módulos Nest (composition root) e app factory
  main.ts            entrypoint
test/
  unit/ integration/ e2e/ cluster/ load/
setup/               scripts de setup, stop e down do ambiente
docker/              init do Postgres, filas FIFO e realm do Keycloak
```

Filas criadas no LocalStack: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` e `wager-events.fifo` (eventos da outbox).

## Workers

O mesmo processo sobe a API e os workers. Para separar papéis:

| Variável | Default | Efeito |
| --- | --- | --- |
| `WORKERS` | `consumer,outbox,pending-reference` | quais workers sobem (`none` para nenhum) |
| `HTTP_ENABLED` | `true` | `false` sobe só os workers |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | visibilidade da mensagem em processamento |
| `INSTANCE_ID` | `host:pid` | id da instância nos logs e no lease da outbox |

Mensagem de exemplo na fila (`MessageGroupId` = walletId):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "<playerId>",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
``` A deduplicação do FIFO é otimização. A garantia fica no banco, como descrito na arquitetura.
