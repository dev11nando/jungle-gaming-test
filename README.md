# Jungle Gaming — processador de apostas

Serviço financeiro distribuído que processa transações de aposta vindas de vários provedores. Esta etapa deixa o contrato fechado e um esqueleto que sobe: NestJS no Bun, PostgreSQL, SQS no LocalStack e Keycloak protegendo a API HTTP. As regras de saldo, ledger e fila ainda não estão implementadas — o desenho está em [ARCHITECTURE.md](ARCHITECTURE.md) e a ordem de construção em [docs/ROADMAP.md](docs/ROADMAP.md).

## O que responde hoje

| Método | Caminho | Auth |
| --- | --- | --- |
| `GET` | `/health/live` | aberta |
| `GET` | `/health/ready` | aberta — Postgres, SQS e Keycloak |
| `GET` | `/whoami` | Bearer JWT do realm `jungle` |

`/whoami` existe para provar o token. Devolve o `providerId` do claim, o client (`azp`) e o `sub`.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker Compose v2 (Docker Desktop com WSL2)
- Portas livres: `3000` (API), `5432` (Postgres), `4566` (LocalStack), `8080` (Keycloak)

## Subir a infra

```bash
cp .env.example .env
bun install
bun run stack:up
```

O Keycloak leva cerca de um minuto na primeira subida. Espere os três serviços ficarem healthy:

```bash
docker compose ps
```

A API no host:

```bash
bun run start:dev
```

Para subir a API dentro do Compose (perfil `app`), em vez de `bun run start:dev`:

```bash
bun run stack:app
```

Parar:

```bash
bun run stack:down
```

`docker compose down -v` apaga os volumes. O Postgres só roda `docker/postgres/init.sql` na primeira criação do volume. Sem `-v`, o realm do Keycloak também permanece no banco dele.

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
| `bun run start` | sobe a API |
| `bun run start:dev` | sobe a API e recarrega ao salvar |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run stack:up` | Postgres, LocalStack e Keycloak |
| `bun run stack:app` | o mesmo, mais a API no Compose |
| `bun run stack:down` | derruba a stack |

## Layout

```text
src/health/          liveness e readiness
src/iam/             guard OIDC, @Public(), ProviderIdentityPort
src/modules/         domínio, aplicação, persistência e mensageria (ainda vazios)
docker/              init do Postgres, filas FIFO e realm do Keycloak
```

Filas criadas no LocalStack: `wager-transactions.fifo` e `wager-transactions-dlq.fifo`. A deduplicação do FIFO é otimização. A garantia fica no banco, como descrito na arquitetura.
