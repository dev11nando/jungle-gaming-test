# Roadmap

Cada fase só começa com a anterior estável. A fase 1 é esta entrega. O invariante final de qualquer teste que mexa em saldo é `wallet.balance == saldo reconstruído pelo ledger`.

## Fase 1 — Esqueleto (esta entrega)

Pronto quando:

- README, ARCHITECTURE e este roadmap descrevem o contrato.
- `docker compose up` sobe Postgres, LocalStack (com as duas filas FIFO) e Keycloak com o realm `jungle`.
- A API sobe no Bun, `/health/live` e `/health/ready` são públicos, `/whoami` exige JWT.

Fora desta fase: agregados, migrations, use cases de aposta, consumidor, outbox e testes de integração.

## Fase 2 — Domínio

`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` e os eventos de integração. Construtor privado, factories `create` / `from` / `rehydrate`. Reidratação não revalida transição.

Testes unitários, sem banco:

- escala 2, entradas inválidas e conflito de moeda em `Money`;
- saldo não negativo, versão e abertura da wallet;
- BET, WIN, LOSS, REFUND e ROLLBACK;
- mesma idempotency key com payload diferente é conflito.

## Fase 3 — Schema

Migrations MikroORM com `up` e `down`. As invariantes da seção de schema em [ARCHITECTURE.md](../ARCHITECTURE.md) existem como constraint, índice único ou trigger — não só no código.

Teste de integração sobe Postgres real e prova que saldo negativo, ledger alterado, wallet duplicada e segunda reversão processada são rejeitados pelo banco.

## Fase 4 — HTTP de wallet e aposta

- `POST /wallets` com OPENING na mesma transação SQL quando o saldo inicial é maior que zero.
- `GET` de wallet, ledger com cursor opaco e transação (por id interno e por id do provedor).
- `POST /wagering/transactions` com `Idempotency-Key`, replay e 409 de payload divergente.
- `POST /wallets/:walletId/reconciliation` sem correção silenciosa.
- Mapa HTTP da arquitetura, igual em todos os endpoints.

## Fase 5 — SQS

Consumidor de `wager-transactions.fifo` reutiliza o use case da fase 4. Inbox por `(consumerName, messageId)`. Ack só depois do commit. Erro de negócio dá ack; transitório devolve a mensagem com backoff; permanente vai para a DLQ depois do limite. SIGTERM termina o que está em voo ou devolve a visibilidade.

## Fase 6 — Outbox e referência pendente

Publisher com `FOR UPDATE SKIP LOCKED`, seguro com dois publishers. Referência ausente fica `PENDING_REFERENCE` e o worker aplica o backoff documentado (8 tentativas ou 15 minutos). Esgotou: `REJECTED`, `REFERENCE_NOT_FOUND` e evento.

## Fase 7 — Corrida e falha

Postgres e LocalStack reais. Paralelismo de verdade, não mock sequencial.

- a mesma aposta 50 vezes em paralelo produz um único débito;
- saldo 100.00, duas apostas simultâneas de 80.00: uma `PROCESSED`, uma `REJECTED` por `INSUFFICIENT_FUNDS`, saldo 20.00, um lançamento de débito, retry não duplica o débito;
- wallets distintas em paralelo;
- três ou mais instâncias;
- processo morto depois do commit e antes do ack;
- dois publishers na mesma outbox;
- REFUND ou ROLLBACK entregue antes da referência;
- reinício do serviço com a consistência final comprovada.

## Fase 8 — Observabilidade

Logs JSON (Pino) com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem payload financeiro completo. Métricas: transações por status, duplicatas, retries, DLQ, conflitos de lock, lag da outbox e latência.

Carga, se entrar: `bun run test:load`, com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos e lag. Sem meta de RPS.
