# Módulos

Pastas reservadas para as próximas fases. Ainda não há regra de negócio aqui.

| Pasta | Vai receber |
| --- | --- |
| `wagering/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, inbox, outbox e eventos. Sem Nest e sem MikroORM. |
| `wagering/application` | Casos de uso usados pela HTTP e pela fila: abrir wallet, submeter transação, consultar, reconciliar. |
| `wagering/infrastructure` | Entidades MikroORM, repositórios, migrations e o mapeamento `numeric(19,2)` ↔ centavos. |
| `messaging` | Consumidor SQS, publisher da outbox e o worker de `PENDING_REFERENCE`. |
| `observability` | Logger JSON e métricas da fase 8. |

A identidade do provedor entra pelos casos de uso via `ProviderIdentityPort` (`src/iam`). A comparação do claim com o `providerId` do corpo é `assertSameProvider`.
