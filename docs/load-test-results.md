# Resultados do teste de carga (gerado por `bun run test:load`)

Execução: 2026-11-13T23:05:52.170Z

## Ambiente

| | |
| --- | --- |
| Máquina | AMD Ryzen 7 5700X3D 8-Core Processor · 16 threads · 32 GB · win32 10.0.26300 |
| Runtime | Bun 1.4.4 |
| Infra | PostgreSQL 16 e LocalStack 4 em Docker Desktop (WSL2), mesma máquina |
| Instâncias | 3 processos `bun src/main.ts` (HTTP + consumer + outbox + pending-reference), pool de 10 conexões cada |

## Parâmetros

Duração HTTP 30s · 64 clientes concorrentes · 100 wallets normais + 1 wallet quente (100.00) · 3000 mensagens SQS.
Mix HTTP: 60% BET, 10% WIN, 10% replay de requisição já enviada, 10% BET de 1.00 na wallet quente, 10% REFUND de BET aceita.

## HTTP — POST /wagering/transactions

| Métrica | Valor |
| --- | --- |
| Requisições | 16002 |
| Throughput | 530.1 req/s |
| Latência p50 / p95 / p99 | 97.7 / 299.4 / 430.6 ms |
| Erros (5xx ou falha de rede) | 0 (0.00%) |
| Status | 200: 14160 · 422: 1842 |

| Operação | n | p50 ms | p95 ms | p99 ms | status |
| --- | --- | --- | --- | --- | --- |
| bet | 9624 | 96.7 | 209.1 | 287.3 | 200: 9624 |
| win | 1642 | 96.0 | 204.3 | 254.6 | 200: 1642 |
| replay | 1548 | 33.5 | 93.3 | 125.5 | 200: 1385, 422: 163 |
| hot-bet | 1531 | 293.1 | 492.4 | 771.5 | 200: 100, 422: 1431 |
| refund | 1657 | 102.7 | 210.5 | 275.8 | 200: 1409, 422: 248 |

## SQS

| Métrica | Valor |
| --- | --- |
| Mensagens | 3000 |
| Tempo até todas aplicadas | 12.7 s |
| Throughput | 236.3 msg/s |
| Latência envio → commit p50 / p95 / p99 | 6831 / 11852 / 12279 ms |

## Concorrência e outbox

| Métrica | Valor |
| --- | --- |
| Conflitos de lock (`wagering_lock_conflicts_total`) | 0 |
| Retries de corrida de unicidade / SQS | 0 |
| Duplicatas detectadas | 1548 |
| Outbox: eventos publicados | 33431 |
| Outbox: commit → publicação p50 / p95 / p99 | 224 / 422 / 580 ms |
| Outbox: pendentes máx. amostrado | 460 |
| Outbox: idade máx. do pendente mais antigo | 0.60 s |

## Invariantes no fim

| | |
| --- | --- |
| Wallets com saldo ≠ ledger | 0 |
| Transações por status | PROCESSED: 15775 · REJECTED: 1679 |
