# Módulos

| Pasta | Conteúdo |
| --- | --- |
| `wagering/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `processWager` e eventos. Sem Nest e sem MikroORM. |
| `wagering/application` | Casos de uso usados pela HTTP e pela fila: abrir wallet, submeter transação, consultas, reconciliação, pendências de referência. Portas (`UnitOfWork`, repositórios). |
| `wagering/infrastructure` | Repositórios MikroORM e mapeamento record ↔ agregado. |
| `wagering/http` | Controllers, mapa de status e correlation id. |
| `messaging/domain` | `InboxMessage` e `OutboxMessage`. |
| `messaging/application` | Classificação de mensagens SQS (ack, retry, DLQ). |
| `messaging/infrastructure` | Consumidor SQS, publisher da outbox com lease, loop de workers. |
| `observability` | Logger JSON e métricas Prometheus. |

Schema, migrations e `EntitySchema` ficam em `src/infrastructure/database`. A identidade do provedor chega aos controllers pela `ProviderIdentityPort` (`src/iam`).
