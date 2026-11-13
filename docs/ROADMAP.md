# Roadmap

Cada fase só começa com a anterior estável. Todas as fases concluídas. O invariante final de qualquer teste que mexa em saldo é `wallet.balance == saldo reconstruído pelo ledger`.

## Fase 1 — Esqueleto ✅

Pronto quando:

- README, ARCHITECTURE e este roadmap descrevem o contrato.
- `docker compose up` sobe Postgres, LocalStack (com as duas filas FIFO) e Keycloak com o realm `jungle`.
- A API sobe no Bun, `/health/live` e `/health/ready` são públicos, `/whoami` exige JWT.

Fora desta fase: agregados, migrations, use cases de aposta, consumidor, outbox e testes de integração.

## Fase 2 — Domínio ✅ (`bun run test`)

`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` e os eventos de integração. Construtor privado, factories `create` / `from` / `rehydrate`. Reidratação não revalida transição.

Testes unitários, sem banco:

- escala 2, entradas inválidas e conflito de moeda em `Money`;
- saldo não negativo, versão e abertura da wallet;
- BET, WIN, LOSS, REFUND e ROLLBACK;
- mesma idempotency key com payload diferente é conflito.

## Fase 3 — Schema ✅ (`bun run test:integration`)

Migrations MikroORM com `up` e `down`. As invariantes da seção de schema em [ARCHITECTURE.md](../ARCHITECTURE.md) existem como constraint, índice único ou trigger — não só no código.

Teste de integração sobe Postgres real e prova que saldo negativo, ledger alterado, wallet duplicada e segunda reversão processada são rejeitados pelo banco.

## Fase 4 — HTTP de wallet e aposta ✅ (`bun run test:integration`, `bun run test:e2e`)

Já cobre também, adiantado da fase 7: 2×80 simultâneas, a mesma aposta 50× em paralelo, wallets distintas em paralelo, prova de ausência de lock global e atomicidade com falha injetada na outbox. Logs JSON e `/metrics` adiantados da fase 8.

- `POST /wallets` com OPENING na mesma transação SQL quando o saldo inicial é maior que zero.
- `GET` de wallet, ledger com cursor opaco e transação (por id interno e por id do provedor).
- `POST /wagering/transactions` com `Idempotency-Key`, replay e 409 de payload divergente.
- `POST /wallets/:walletId/reconciliation` sem correção silenciosa.
- Mapa HTTP da arquitetura, igual em todos os endpoints.

## Fase 5 — SQS ✅

Consumidor de `wager-transactions.fifo` reutiliza o use case da fase 4. Inbox por `(consumerName, messageId)`. Ack só depois do commit. Erro de negócio dá ack; transitório devolve a mensagem com backoff; permanente vai para a DLQ depois do limite. SIGTERM termina o que está em voo ou devolve a visibilidade.

## Fase 6 — Outbox e referência pendente ✅

Cobertas em `test/integration/sqs-consumer.test.ts` e `outbox-and-pending.test.ts`, inclusive crash entre commit e ack, SIGTERM, dois publishers, crash entre publicação e marcação e três consumidores concorrentes.

Publisher com `FOR UPDATE SKIP LOCKED`, seguro com dois publishers. Referência ausente fica `PENDING_REFERENCE` e o worker aplica o backoff documentado (8 tentativas ou 15 minutos). Esgotou: `REJECTED`, `REFERENCE_NOT_FOUND` e evento.

## Fase 7 — Corrida e falha ✅ (`bun run test:cluster`)

Postgres e LocalStack reais. Paralelismo de verdade, não mock sequencial.

| Cenário obrigatório | Onde |
| --- | --- |
| a mesma aposta 50× em paralelo → um débito | `test/integration/wagering.test.ts` e `test/cluster/multi-instance.test.ts` (50× distribuídas em 3 processos) |
| 100.00 e duas apostas simultâneas de 80.00 | `wagering.test.ts` (caso de uso) e `test/e2e/http.test.ts` (HTTP) |
| wallets distintas em paralelo, sem lock global | `wagering.test.ts` |
| três ou mais instâncias | `multi-instance.test.ts`: 3 processos `bun src/main.ts` com HTTP + todos os workers |
| processo morto depois do commit e antes do ack | `sqs-consumer.test.ts` (in-process) e `multi-instance.test.ts` (SIGKILL de um nó no meio do tráfego) |
| dois publishers na mesma outbox | `outbox-and-pending.test.ts` e os 3 publishers do cluster |
| REFUND/ROLLBACK antes da referência | `outbox-and-pending.test.ts` e o cluster (20 REFUNDs antes das BETs via SQS) |
| reinício do serviço com consistência final | `multi-instance.test.ts`: derruba tudo, sobe um nó, reconcilia todas as wallets via HTTP e confere que todo evento da outbox foi publicado |

Todo arquivo que mexe em saldo termina com `assertAllWalletsReconcile`: `wallet.balance` igual ao saldo reconstruído pelo ledger, para todas as wallets do banco.

## Fase 8 — Observabilidade ✅

Logs JSON (`JsonLogger`, lista permitida de campos) com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem payload financeiro completo. Métricas: transações por status, duplicatas, retries, DLQ, conflitos de lock, lag da outbox e latência.

Carga: `bun run test:load`, com metodologia e análise em [load-test.md](load-test.md).
