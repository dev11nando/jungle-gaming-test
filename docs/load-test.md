# Teste de carga

```bash
bun run stack:up
bun run test:load
```

Parâmetros por variável de ambiente: `LOAD_DURATION_S` (30), `LOAD_CONCURRENCY` (64), `LOAD_NODES` (3), `LOAD_WALLETS` (100), `LOAD_HOT_BALANCE` (100.00), `LOAD_SQS_MESSAGES` (3000). Os números da última execução ficam em [load-test-results.md](load-test-results.md), gerado pelo script.

## Metodologia

- O script sobe `LOAD_NODES` processos reais (`bun src/main.ts`, HTTP + todos os workers) contra um banco dedicado (`wagering_load`, recriado a cada execução) e filas próprias no LocalStack. Tokens JWT são validados pelo guard real, com JWKS servido localmente.
- **Fase HTTP**: `LOAD_CONCURRENCY` clientes em loop fechado por `LOAD_DURATION_S`, round-robin entre as instâncias. Mix: 60% BET em wallets com saldo alto, 10% WIN, 10% replay de requisição já enviada (mesma key e corpo), 10% BET de 1.00 numa única wallet quente com saldo baixo, 10% REFUND de BET aceita (pode repetir a mesma BET, gerando `ALREADY_REVERSED`).
- **Fase SQS**: `LOAD_SQS_MESSAGES` BETs enviadas de uma vez (lotes de 10), com `MessageGroupId` = wallet. Mede o tempo até todas existirem no banco e a fila esvaziar.
- **Outbox**: `/metrics` de cada instância é amostrado a cada segundo; no fim, a distribuição de `published_at − occurred_at` é lida do banco.
- **Invariante**: no fim, nenhuma wallet pode ter saldo diferente da soma do ledger; o script sai com erro se tiver.

## Resultado de referência

Ryzen 7 5700X3D (16 threads), 32 GB, Windows 11, Docker Desktop/WSL2, Bun 1.4.4. Três instâncias, 64 clientes, 30s.

| | |
| --- | --- |
| HTTP | 530 req/s · p50 98 ms · p95 299 ms · p99 431 ms · 0 erros 5xx |
| Wallet quente (saldo 100.00, apostas de 1.00) | exatamente 100 aceitas, 1431 `INSUFFICIENT_FUNDS` · p50 293 ms |
| Replay | p50 34 ms (caminho rápido, sem lock) |
| SQS | 3000 mensagens em 12,7 s (236 msg/s) |
| Outbox commit → publicação | p50 224 ms · p99 580 ms · pendente mais antigo ≤ 0,6 s |
| Conflitos de lock (timeout/deadlock) | 0 |
| Invariante saldo = ledger | 0 divergências em 17.454 transações |

## Leitura honesta

- **A wallet quente é o gargalo esperado.** Todas as apostas nela serializam no `FOR UPDATE` da mesma linha; a latência sobe (p50 3× a de uma wallet comum) mas o resultado é exato: 100 apostas de 1.00 sobre 100.00. `wagering_lock_conflicts_total` conta só timeout de lock e deadlock, não espera — a espera aparece na latência dessa operação. Nenhuma requisição chegou ao `lock_timeout` de 5 s.
- **Latência SQS envio → commit (p50 ~7 s) é fila, não processamento.** As 3000 mensagens entram de uma vez e são drenadas a ~236 msg/s; a latência mede quanto cada uma esperou na fila. FIFO por wallet limita o paralelismo ao número de wallets com mensagem visível, e cada mensagem é uma transação SQL com lock.
- **Outbox**: a primeira versão publicava 10 eventos por ciclo e ficava ~2,5 s atrás do commit. Reservar até 100 por ciclo e enviar em lotes de 10 em paralelo derrubou para p50 224 ms com 33 mil eventos publicados.
- **O que este teste não mede**: cliente, aplicação, PostgreSQL e LocalStack dividem a mesma máquina, então os números são de ordem de grandeza, não de capacidade. LocalStack não reproduz latência nem limites do SQS real. Não há teste de duração longa (vazamento, crescimento de tabelas) nem com falha injetada durante a carga — essas falhas estão cobertas nos testes de integração e no `test:cluster`.
- **Onde escalaria primeiro**: pool de conexões (10 por instância) e o número de pollers SQS (`SQS_POLLERS`, 4 por instância). O desenho não tem lock global, então wallets distintas escalam horizontalmente; a wallet quente não escala por design.
