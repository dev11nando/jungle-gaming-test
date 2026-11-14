# Arquitetura

Processador de apostas com uma regra de ouro: o PostgreSQL confirma saldo, ledger, inbox e outbox na mesma transação, ou não confirma nada. SQS entrega at-least-once e pode reordenar. Várias instâncias podem tocar a mesma wallet. A correção não depende de cache em memória nem de fila FIFO.

Todas as fases do [roadmap](docs/ROADMAP.md) estão implementadas e testadas contra PostgreSQL e LocalStack reais, inclusive com três instâncias em processos separados. Resultado de carga em [docs/load-test.md](docs/load-test.md).

## Fluxo

```mermaid
flowchart TD
  http[POST HTTP]
  sqs[Mensagem SQS]
  oidc[JWT Keycloak]
  trusted[Canal interno]
  usecase[SubmitWagerTransaction]
  sql[Transação SQL]
  inbox[Inbox]
  lock[FOR UPDATE da wallet]
  ledger[Ledger imutável]
  outbox[Outbox]
  commit[Commit]
  ack[Ack]
  publish[Publisher SKIP LOCKED]
  pending[Worker de referência]

  http --> oidc --> usecase
  sqs --> trusted --> usecase
  usecase --> sql
  sql --> inbox
  sql --> lock
  lock --> ledger
  lock --> outbox
  sql --> commit
  commit --> ack
  commit --> publish
  usecase --> pending
```

A entrada HTTP e a entrada da fila chamam o mesmo caso de uso. A diferença é a borda:

- HTTP exige Bearer JWT. O claim `provider_id` tem de ser o mesmo `providerId` do corpo (senão 403 `PROVIDER_MISMATCH`). O controller lê a identidade pela `ProviderIdentityPort` e compara antes de chamar o caso de uso, que não conhece JWT.
- A fila é canal interno. Não há assinatura na mensagem nesta versão. O `providerId` do payload continua passando pela validação de domínio: existe, cabe na operação, e a referência resolvida pertence a esse provedor.

Ack da mensagem só depois do commit. Se o processo morre no meio, a transação SQL desfaz. Se morre depois do commit e antes do ack, a reentrega encontra a inbox ou a idempotency key e não aplica o efeito de novo.

Evento de integração só é inserido na outbox dentro dessa mesma transação. Publicar antes do commit está fora do desenho.

## Camadas

Clean Architecture simplificada, em quatro pastas:

| Camada | Pasta | Pode depender de |
| --- | --- | --- |
| Domínio | `src/domain` (entities, events, services, errors, contracts, usecases) | só de si mesmo |
| Adapters | `src/infra` (MikroORM, SQS, Keycloak/JWT, logger, métricas) | domínio |
| Apresentação | `src/presentation/http` (controllers, filtro de erros, presenters) | domínio e infra |
| Composição | `src/main` (módulos Nest) | tudo |

- **Contratos são `interface`** em `domain/contracts`, cada um com um token (`UNIT_OF_WORK`, `CLOCK`, `ID_GENERATOR`, `METRICS`, `PROVIDER_IDENTITY`), porque interface some em runtime e o Nest precisa de algo para injetar.
- **Casos de uso são classes puras**: sem `@Injectable`, sem `@Inject`, sem importar Nest, MikroORM ou AWS. Recebem os contratos no construtor e são montados por factories em `main/modules`. Log também é contrato (`Logger`), com adapter sobre o logger do Nest.
- **Adapters implementam os contratos** (`MikroOrmUnitOfWork implements UnitOfWork`, `PrometheusMetrics implements Metrics`, `SystemClock implements Clock`…). Trocar o banco ou a fila não toca no domínio.
- Os testes usam a mesma montagem: `buildServices` instancia os casos de uso com os adapters reais, e `FailingUnitOfWork` implementa o mesmo contrato para injetar falha.

Deliberadamente fora: interface para cada classe, DTO de saída por caso de uso (os presenters já isolam o formato HTTP) e camadas que só repassam chamada.

## Dinheiro

`Money` é imutável. Cada operação devolve outra instância. Por dentro, o valor é um `bigint` de centavos, escala fixa 2. A borda HTTP, a fila e o `data` dos eventos falam só isto:

```json
{ "amount": "25.00", "currency": "BRL" }
```

O domínio não importa tipo monetário do MikroORM nem decorator do Nest. `number`, `float` e `double` não entram em conta.

Regras de entrada: rejeitar vazio, `NaN`, `Infinity`, notação científica, mais de duas casas, sinal negativo nos contratos de entrada e moeda que não seja ISO-4217 de três letras. Moedas diferentes lançam erro de domínio. A operação do dia é BRL; o tipo continua multi-moeda para o conflito ser testável.

No Postgres a coluna é `numeric(19,2)`. O driver devolve string. A reidratação converte para centavos. `numeric` é exato; a string na borda evita o `number` do JavaScript.

## Modelo

Construtor `private` ou `protected`. Criação por `create`, `from` ou `open`. O que sai do banco volta por `rehydrate`, que reconstrói estado já persistido e não reaplica regra de transição.

### Wallet

No máximo uma wallet por `(playerId, currency)`. Saldo nunca negativo. Toda mudança de saldo tem um lançamento, e todo lançamento explica uma mudança. `version` nasce em 1 e só aumenta quando o saldo muda. LOSS não mexe em saldo, não gera ledger e não incrementa versão.

`POST /wallets` com saldo inicial maior que zero grava, na mesma transação, a wallet, uma `WagerTransaction` `OPENING` e um crédito no ledger. Saldo inicial zero: wallet versão 1 e ledger vazio. `OPENING` não entra pela API de aposta nem pela fila.

### WagerTransaction

| Kind | Saldo | Ledger | Regra |
| --- | --- | --- | --- |
| BET | débito | um DEBIT | rejeita se não há saldo |
| WIN | crédito | um CREDIT | pode apontar para a BET da mesma rodada |
| LOSS | nenhum | nenhum | registra o resultado |
| REFUND | crédito | um CREDIT | reverte uma BET `PROCESSED`, uma vez, valor igual |
| ROLLBACK | inverso da referência | uma entrada invertida | reverte BET, WIN ou REFUND `PROCESSED`, uma vez, valor igual |

REFUND e ROLLBACK exigem `referenceExternalTransactionId`. A referência é `(providerId, referenceExternalTransactionId)` e tem de ser o mesmo provedor, player, wallet, moeda e rodada. WIN (e LOSS) com referência segue o mesmo escopo e só pode apontar para BET; sem referência, o crédito vale sozinho. A referência precisa estar `PROCESSED`: se ainda está pendente, a operação espera como `PENDING_REFERENCE`; se terminou `REJECTED`/`FAILED`, a operação é rejeitada com `REFERENCE_NOT_PROCESSED`.

**Interpretação adotada — uma reversão por referência, de qualquer tipo.** O enunciado proíbe reverter duas vezes "pelo mesmo tipo". Adotamos a regra mais estrita: uma transação aceita no máximo **uma** reversão `PROCESSED`, seja REFUND ou ROLLBACK. Sem isso, REFUND + ROLLBACK da mesma BET creditaria o jogador duas vezes. Desfazer um REFUND continua possível com ROLLBACK do próprio REFUND (outra referência). No banco: índice único parcial em `reference_transaction_id` para `status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`.

O processamento é um serviço de domínio puro (`processWager`) que recebe a wallet já travada, a referência resolvida e o fato de ela já ter sido revertida, e devolve `PROCESSED` (com o lançamento), `REJECTED` (com failure code) ou `PENDING_REFERENCE`. A ordem das checagens é: moeda → player → referência (existência, status, escopo, kind, valor, já revertida) → saldo.

Uma reversão que deixaria o saldo negativo é `REVERSAL_WOULD_GO_NEGATIVE`, diferente de `INSUFFICIENT_FUNDS`. Os dois ficam auditáveis. Reversão parcial não existe.

Status `PROCESSED`, `REJECTED` e `FAILED` são terminais. Transição a partir deles é erro de programação (`InvalidTransactionStateError`), não um ramo de negócio.

Transições aceitas:

- `PENDING` → `PROCESSED` | `PENDING_REFERENCE` | `REJECTED` | `FAILED`
- `PENDING_REFERENCE` → `PROCESSED` | `PENDING_REFERENCE` (nova tentativa agendada) | `REJECTED` | `FAILED`

No banco, um trigger recusa qualquer `UPDATE` em linha terminal e qualquer volta para `PENDING`.

`REJECTED` não altera saldo e não gera ledger. Repetir uma operação já terminada devolve o resultado original, inclusive o saldo observado naquele momento. Esse saldo é gravado na transação no commit. Não se relê o saldo atual da wallet para montar o replay.

A mesma idempotency key com outro payload é conflito. Não é replay e não cria segunda linha.

### Ledger

`WalletLedgerEntry` não tem campo mutável nem método de transição (todos `readonly`, objeto congelado). `create` exige `balanceBefore ± money = balanceAfter`, valor positivo e saldos não negativos. Cada lançamento carrega `walletVersion` (a versão da wallet depois dele): a abertura é a versão 1, cada movimento seguinte é +1. No máximo um lançamento por transação e por wallet. Update, delete e truncate são recusados por trigger.

### Inbox e outbox

`InboxMessage`, a mudança financeira, o ledger e a `OutboxMessage` entram na mesma transação SQL quando a origem é a fila. Na origem HTTP não há inbox; o restante continua atômico.

A outbox guarda o envelope já serializado (`toJSON` do evento). `Money` no `data` é `MoneyProps`, nunca a instância.

Eventos mínimos:

| Evento | Quando |
| --- | --- |
| `WagerTransactionProcessed` | aplicada, inclusive LOSS |
| `WagerTransactionRejected` | rejeitada por regra de negócio |
| `WalletBalanceChanged` | só quando o saldo muda |
| `WagerTransactionPendingReference` | referência ainda não existe |

## Idempotência

O header `Idempotency-Key` é a fonte da verdade. O default recomendado ao cliente é `{providerId}:{externalTransactionId}`. O servidor não recompõe a chave se o header vier preenchido, e recusa a requisição se o header faltar.

`payloadHash` é SHA-256 em hexadecimal de um JSON canônico:

1. Só entram campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`amount`, `currency`) e, se presente, `referenceExternalTransactionId`.
2. Chaves ordenadas em todo objeto. Sem espaços. Campo ausente fica de fora; não se grava `null` no lugar.
3. Header, `messageId` e o restante do transporte ficam de fora.

O `amount` entra no hash já normalizado para escala 2: `"25"` e `"25.00"` são a mesma operação. `walletId` entra em minúsculas.

Inbox única em `(consumer_name, message_id)`. Deduplicação e FIFO do SQS encurtam reentrega; não substituem essas restrições.

### Fluxo de `SubmitWagerTransaction` (HTTP e fila)

1. **Validação de contrato** (`parseSubmitWagerCommand`) e cálculo do hash. Erro aqui → 400, nada persistido.
2. **Caminho rápido, sem lock**: busca pela idempotency key. Achou → mesmo hash é replay (resultado gravado, inclusive saldo observado); hash diferente é `IDEMPOTENCY_KEY_REUSED` (409).
3. **Transação SQL** (`lock_timeout` 5s, `statement_timeout` 15s):
   1. `SELECT … FOR UPDATE` na wallet (`LockMode.PESSIMISTIC_WRITE`). Ausente → 404.
   2. Releitura da key **sob o lock**: quem esperou o lock enxerga o commit de quem chegou antes (READ COMMITTED relê a cada statement). Duplicata → replay.
   3. `(providerId, externalTransactionId)` já existente com outra key → `EXTERNAL_TRANSACTION_ID_REUSED` (409).
   4. Resolve a referência, verifica reversão prévia, roda `processWager`.
   5. Grava transação → `UPDATE wallets … WHERE version = ?` → ledger → outbox (→ inbox, se veio da fila). Commit.
4. **Corrida de unicidade**: se outra instância inseriu a mesma key/inbox entre os passos 2 e 3.5 (possível quando a mesma key aponta para wallets diferentes), o `UNIQUE` aborta esta transação inteira; o caso de uso volta ao passo 2 (até 2 vezes) e responde como replay ou conflito.

Uma operação toca uma única wallet, então há um único lock por transação: sem ordem de aquisição a respeitar e sem deadlock possível entre operações de aposta.

## Concorrência

A unidade de lock é a linha da wallet. Dentro da transação SQL: `SELECT … FOR UPDATE` dessa linha, aplica a regra, grava ledger e outbox, incrementa `version` se o saldo mudou. Duas wallets seguem em paralelo. Não há lock global.

O `UPDATE` do saldo também exige a `version` lida no lock. Se algum caminho esquecer o `FOR UPDATE`, a segunda escrita não passa. O lock pessimista é a estratégia principal, porque a wallet quente (duas apostas de 80.00 sobre 100.00) precisa serializar sem tempestade de retry. A versão é a segunda trava e o número que a API devolve.

O banco ainda segura o que o lock não endereça. Tudo abaixo está na migration `Migration20261113000000_initial_schema` e tem teste em `test/integration/schema.test.ts`:

| Invariante | Mecanismo no PostgreSQL |
| --- | --- |
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance_amount >= 0)` em wallets e `balance_before/after >= 0` no ledger |
| idempotência persistente | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| ledger imutável | triggers recusam `UPDATE`, `DELETE` e `TRUNCATE` |
| aritmética de cada lançamento | `CHECK` `balance_after = balance_before ± amount`, `amount > 0` |
| um lançamento por transação | `UNIQUE (transaction_id)` e `UNIQUE (wallet_id, transaction_id)` |
| lançamento coerente com a transação | FK composta `(transaction_id, wallet_id, amount, currency)` → `wager_transactions`; FK `(wallet_id, currency)` → `wallets` |
| ledger encadeado, sem bifurcação | `UNIQUE (wallet_id, wallet_version)` + trigger: `balance_before` = `balance_after` da versão anterior |
| saldo materializado = ledger | constraint trigger **diferida** em `wallets`: no commit, existe lançamento com `wallet_version = version` e `balance_after = balance_amount` (ou wallet zerada na versão 1 sem lançamentos) |
| uma reversão processada por referência | índice único parcial em `reference_transaction_id` |
| REFUND/ROLLBACK com referência | `CHECK` |
| OPENING é interno | `CHECK ((kind = 'OPENING') = (provider_id = 'internal'))` |
| estados terminais imutáveis | trigger recusa qualquer `UPDATE` em linha `PROCESSED/REJECTED/FAILED`, mudança de campo de negócio e `DELETE` |
| consistência de status | `CHECK`s: `failure_code` sse `REJECTED/FAILED`; `completed_at` sse terminal; `PROCESSED` tem saldo resultante; `PENDING_REFERENCE` tem próxima tentativa |
| inbox única | `PRIMARY KEY (consumer_name, message_id)` |
| outbox íntegra | `CHECK` de `payload.eventId = id`; trigger torna o evento imutável e `published_at` definitivo |

A constraint trigger diferida é o que fecha "toda alteração de saldo tem lançamento (e vice-versa)" no banco, não só no código: um `UPDATE wallets` sem lançamento correspondente aborta o commit inteiro.

Cenário obrigatório: saldo 100.00 BRL, duas apostas simultâneas de 80.00. Uma fica `PROCESSED`, a outra `REJECTED` com `INSUFFICIENT_FUNDS`, saldo final 20.00, um débito no ledger. Retry não cria outro débito.

## Referência fora de ordem

Se a referência não existe, a transação persiste como `PENDING_REFERENCE` e a resposta HTTP é 202. Um worker reprocessa com backoff exponencial a partir de 1s, dobrando até o teto de 60s.

Limite: 8 tentativas ou 15 minutos desde `createdAt`, o que ocorrer primeiro. O teto cabe numa rodada de jogo que ainda pode chegar atrasada, e não deixa linha pendente a noite inteira. Esgotou o limite: `REJECTED`, `REFERENCE_NOT_FOUND`, evento `WagerTransactionRejected`.

O worker (`ProcessPendingReferences`, a cada 250ms quando ocioso) busca pendências vencidas e processa cada uma numa transação própria: trava a wallet, depois a linha da transação, revalida o status e reaplica todas as regras (`processWager`). É a mesma ordem de lock da submissão, então dois workers sobre a mesma pendência serializam e só um aplica.

Quando qualquer transação termina, as pendências que apontam para ela têm `next_reference_attempt_at` antecipado para agora, na mesma transação SQL. A referência atrasada destrava a pendência no próximo ciclo do worker, sem esperar o backoff.

## Failure codes

Estáveis, em `SCREAMING_SNAKE`, para o provedor decidir se reenvia, corrige o payload ou desiste.

Rejeições persistidas (`status = REJECTED`, HTTP 422, evento `WagerTransactionRejected`):

| Código | Significado | O provedor |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | BET sem saldo | não reenvia igual |
| `REVERSAL_WOULD_GO_NEGATIVE` | ROLLBACK de WIN/REFUND deixaria saldo negativo | não reenvia igual |
| `CURRENCY_MISMATCH` | moeda da operação diferente da wallet | corrige o payload |
| `PLAYER_WALLET_MISMATCH` | `playerId` não é o dono da wallet | corrige o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite | desiste ou investiga |
| `REFERENCE_NOT_PROCESSED` | a referência existe, mas terminou `REJECTED`/`FAILED` | desiste |
| `REFERENCE_KIND_NOT_ALLOWED` | REFUND/WIN/LOSS fora de BET, ou ROLLBACK fora de BET, WIN e REFUND | corrige o payload |
| `REFERENCE_SCOPE_MISMATCH` | referência de outro player, wallet, moeda ou rodada | corrige o payload |
| `AMOUNT_MISMATCH` | valor diferente do da referência | corrige o payload |
| `ALREADY_REVERSED` | a referência já tem uma reversão `PROCESSED` | não reenvia como operação nova |

Erros de contrato, que não viram linha (HTTP 400, ou 404 para wallet): `INVALID_MONEY`, `INVALID_FIELD`, `INVALID_KIND`, `REFERENCE_REQUIRED`, `INVALID_REFERENCE` (autorreferência), `OPENING_NOT_SUBMITTABLE`, `WALLET_NOT_FOUND`. Não são persistidos porque o payload não descreve uma operação válida — não há o que auditar além do log.

Conflito de idempotência (mesma chave, outro hash) não é failure code de transação: a segunda requisição não vira linha. A resposta é 409.

`FAILED` (com `PERMANENT_PROCESSING_ERROR`) existe no modelo e no schema para erro permanente de infraestrutura, mas nenhum fluxo o grava hoje: mensagem que não pode ser aplicada vai para a DLQ com o motivo (ver Mensageria). Rejeição de regra é sempre `REJECTED`.

## HTTP

O mesmo mapa vale para todos os endpoints. O provedor não precisa ler a mensagem para saber se pode reenviar.

| Situação | Status | `error.code` / corpo | Pode reenviar igual? |
| --- | --- | --- | --- |
| payload inválido, header ausente | 400 | `INVALID_MONEY`, `INVALID_FIELD`, `INVALID_KIND`, `REFERENCE_REQUIRED`, `OPENING_NOT_SUBMITTABLE`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_CURSOR`… | não, corrigir |
| token ausente ou inválido | 401 | `UNAUTHORIZED` | com token válido |
| claim `provider_id` ausente ou provedor ≠ corpo | 403 | `FORBIDDEN`, `PROVIDER_MISMATCH` | não |
| recurso ausente | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | não |
| conflito | 409 | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_TRANSACTION_ID_REUSED` | não |
| rejeição de negócio persistida | 422 | `status: REJECTED` + `failureCode` | não (replay repete o 422) |
| `PROCESSED`, inclusive replay | 200 | `idempotentReplay` true/false | sim, é replay |
| aceite ainda não aplicado | 202 | `status: PENDING_REFERENCE` | sim, é replay |
| banco indisponível, timeout de lock, deadlock | 503 + `Retry-After: 1` | `TRANSIENT_INFRASTRUCTURE_ERROR` | **sim**, mesma key |
| bug | 500 | `INTERNAL_ERROR` | — |

Erros têm sempre o corpo `{ "error": { "code", "message" }, "correlationId" }`. Respostas de transação: `{ transactionId, status, balance, idempotentReplay, failureCode? }`, onde `balance` é o saldo observado quando a transação terminou (`null` enquanto pendente).

Replay de uma rejeição repete o 422 original, com `idempotentReplay: true`.

Visibilidade entre provedores: `GET /wagering/transactions/:id` de outro provedor responde 404 (não vaza existência); `GET /providers/:providerId/...` com outro provedor responde 403.

Ledger: `GET /wallets/:walletId/ledger?cursor=&limit=50` (máx. 200). O cursor é opaco (`base64url("v1:<position>")`, onde `position` é uma coluna identity do ledger): estável sob inserts concorrentes, não é offset.

Reconciliação compara o saldo materializado com a soma do ledger. Divergência é log, métrica e `consistent: false`. O endpoint não reescreve saldo.

## Mensageria

Filas: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` e `wager-events.fifo` (eventos publicados pela outbox). `ContentBasedDeduplication` e o redrive (`maxReceiveCount` 5) estão no init do LocalStack como rede de segurança. A inbox e a idempotency key continuam sendo a garantia.

Cada processo escolhe seus papéis por `WORKERS` (`consumer`, `outbox`, `pending-reference` ou `none`) e `HTTP_ENABLED`. Todos compartilham um pool PostgreSQL e um cliente SQS.

### Consumidor

Long polling de até 10 mensagens. Grupos FIFO distintos em paralelo; dentro do grupo, em ordem.

| Situação | Ação |
| --- | --- |
| JSON/envelope inválido, `type` desconhecido | DLQ (`INVALID_JSON`, `INVALID_ENVELOPE`, `UNSUPPORTED_MESSAGE_TYPE`) |
| `(consumer, messageId)` já na inbox, mesmo hash | ack (duplicata de transporte) |
| `messageId` já na inbox com outro hash | DLQ `MESSAGE_ID_CONFLICT` |
| payload inválido, wallet inexistente, conflito de idempotência | DLQ com o `code` do erro |
| processada, rejeitada por regra, pendente de referência, replay | ack, depois do commit |
| erro transitório (banco, lock, deadlock) ou inesperado | sem ack; visibilidade 2^n s (teto 60s) |
| transitório com `receiveCount ≥ SQS_MAX_RECEIVE_COUNT` (5) | DLQ `MAX_ATTEMPTS_EXCEEDED` |

A inbox é gravada na mesma transação que a transação financeira, o ledger e a outbox. O ack (`DeleteMessage`) só acontece depois do commit; se o processo morre entre os dois, a redelivery encontra a inbox (ou a idempotency key, se a mesma operação vier em outro `messageId`) e só dá ack. O próprio consumidor move para a DLQ os erros permanentes, com o atributo `reason`; o redrive do SQS cobre o caso de o consumidor nem conseguir classificar a mensagem.

SIGTERM: `enableShutdownHooks` dispara `beforeApplicationShutdown` antes de o pool fechar. O consumidor para o long polling, termina as mensagens em processamento (até 20s) e devolve com visibilidade 0 as que ainda não começaram.

Não persistimos `FAILED` para mensagem esgotada: se o motivo é banco fora, nem daria para gravar. A DLQ com o motivo é o registro auditável, e reprocessar da DLQ é seguro pela idempotência.

### Publisher da outbox (lease)

1. Transação curta: `UPDATE … SET locked_by, locked_until = now() + 30s` sobre `SELECT … FOR UPDATE SKIP LOCKED` das linhas vencidas e sem lease válido, por `position`. Commit.
2. `SendMessageBatch` fora de qualquer transação SQL, com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`.
3. Sucesso: `published_at = now()` só onde `locked_by` ainda é este worker. Falha: `attempts + 1`, `next_attempt_at` com backoff (1s·2^n, teto 5min), `last_error`, lease liberado.

Se o processo morre depois de publicar e antes de marcar, o lease expira e outra instância publica de novo: duplicação é possível, perda não. Quem consome os eventos deduplica por `eventId` (o FIFO também, dentro de 5 minutos). A outbox não desiste de um evento.

A ordem entre eventos do mesmo agregado não é garantida entre publishers diferentes; o consumidor usa `walletVersion` (em `WalletBalanceChanged`) para ordenar.

## Persistência

MikroORM 6 (`@mikro-orm/postgresql`), pelo `EntityManager.transactional()`, `LockMode.PESSIMISTIC_WRITE` e identity map por request (`em.fork()`). O agregado não conhece coluna nem decorator: os modelos de persistência são `EntitySchema` em `src/infra/database/records.ts`, e o repositório traduz record ↔ agregado por `rehydrate`.

Mapeamento do `Money`: duas colunas, `*_amount numeric(19,2)` e `currency char(3)`. O MikroORM devolve `decimal` como string (`"975.00"`), que vira `bigint` de centavos em `Money.fromStored`. Nenhum valor monetário passa por `number` em nenhum ponto.

Estratégia transacional: uma transação SQL por operação, aberta por `em.transactional()`. Dentro dela, a ordem de escrita é explícita (lock da wallet → transação → `UPDATE` do saldo → ledger → outbox → inbox) em vez de depender do cálculo de ordem do Unit of Work, porque os records não declaram relações e as FKs não são diferíveis. O `UPDATE` do saldo é condicional à versão lida (`where id = ? and version = ?`) e precisa afetar exatamente uma linha.

Migrations versionadas, com `up` e `down`, registradas explicitamente em `migrationsList` (sem glob de arquivos). `bun run db:migrate`, `db:migrate:down`, `db:migrate:status`. Prisma fica de fora.

## Autenticação

Keycloak no Compose, realm `jungle`. A API valida o access token contra o JWKS e exige `iss` do realm e `aud` contendo `wagering-api`. Cada provedor é um client confidential com service account. Um protocol mapper fixa `provider_id` no token; outro adiciona a audience.

Health fica de fora do guard (`@Public()`). A fila não passa pelo guard.

`ProviderIdentityPort` (contrato em `domain/contracts`, token `PROVIDER_IDENTITY`) é a porta de leitura da identidade do request. Hoje a implementação pede o que o guard gravou. Quando a fila precisar de identidade assinada, entra outro adapter atrás da mesma porta, sem o caso de uso conhecer JWT.

A origem das chaves é um provider injetável (`JWT_KEY_RESOLVER`, JWKS remoto por padrão). Os testes e2e trocam só esse provider por uma chave RSA local e assinam tokens com o mesmo `iss`/`aud`/`provider_id`: o guard real roda, sem precisar do Keycloak no ar.

Segredos do realm (`provider-a-secret`, admin/admin) são de desenvolvimento. Não são modelo de produção.

## Observabilidade

- **Logs**: `JsonLogger` (uma linha JSON por evento, `service` e `instanceId` fixos). Campos de contexto passam por uma lista permitida (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `status`, `failureCode`…); qualquer outro campo é descartado, o que impede logar payload financeiro completo ou token por descuido. `X-Correlation-Id` é aceito na entrada (ou gerado) e devolvido na resposta.
- **Métricas**: `GET /metrics` (público, formato Prometheus, por instância). Já emitidas: `wagering_transactions_total{status,kind,replay}`, `wagering_duplicates_total`, `wagering_idempotency_conflicts_total`, `wagering_lock_conflicts_total{reason}`, `wagering_retries_total{reason}`, `wagering_processing_seconds` (histograma), `wagering_reconciliation_divergences_total`. Mensageria: `wagering_sqs_messages_total{action,reason}`, `wagering_dlq_messages_total{reason}`, `wagering_outbox_published_total`, `wagering_outbox_failures_total`, `wagering_outbox_pending`, `wagering_outbox_lag_seconds` (idade do evento pendente mais antigo), `wagering_outbox_publish_delay_seconds` (histograma commit → publicação) e `wagering_pending_reference_total{outcome}`.
- **Health**: `/health/live` só diz que o processo responde. `/health/ready` exige PostgreSQL e SQS; Keycloak aparece no relatório, mas não derruba o readiness — o JWKS já carregado continua validando tokens, e a fila não depende do IdP.

## Testes

| Camada | Comando | O que prova |
| --- | --- | --- |
| Unidade | `bun run test` | Money, Wallet, ledger, regras de cada kind, transições, hash de idempotência, eventos |
| Integração | `bun run test:integration` | migrations e cada constraint/trigger; casos de uso sob concorrência real; consumidor, outbox e pendências contra LocalStack |
| E2E | `bun run test:e2e` | aplicação Nest completa, guard real, mapa de status HTTP |
| Cluster | `bun run test:cluster` | 3 processos reais, HTTP + SQS concorrentes, SIGKILL e reinício |
| Carga | `bun run test:load` | throughput, latência, conflitos e lag da outbox ([docs/load-test.md](docs/load-test.md)) |

Nenhum teste substitui PostgreSQL ou SQS por mock; o único dublê é o resolvedor de chaves JWT. Cada cenário obrigatório do enunciado está mapeado para o teste correspondente em [docs/ROADMAP.md](docs/ROADMAP.md#fase-7--corrida-e-falha--bun-run-testcluster).

## Trade-offs

- Lock pessimista por wallet em vez de só otimista. A wallet quente serializa na linha. O custo é uma aposta esperar a outra na mesma wallet. Wallets diferentes não se esperam. Retry otimista sob duas apostas de 80.00 geraria mais escrita falha do que o `FOR UPDATE`.
- Invariantes duplicadas em domínio e schema. O domínio rejeita cedo e com failure code legível; o banco é a última linha de defesa contra bug, caminho esquecido ou acesso direto. O custo são triggers PL/pgSQL que precisam evoluir junto com o código — por isso cada uma tem teste de integração.
- Centavos em `bigint` em vez de uma biblioteca decimal. A escala do contrato é fixa em 2, então inteiro de centavo não arredonda escondido. O tipo público continua string decimal.
- Um lançamento por movimento, não partidas dobradas. Double-entry fica como diferencial, não como requisito. A reconciliação ainda fecha: saldo contra a soma dos lançamentos.
- Referência pendente com teto curto (8 tentativas ou 15 minutos). Mais tempo segura operação incompleta; menos tempo rejeita BET que ainda está na rede. O número é explícito para poder mudar com dado de produção.
- Fila sem autenticação. Simplifica o desafio e o shutdown. O preço é confiar na rede entre o produtor e o consumidor. A porta de identidade existe para não pintar isso na parede do caso de uso.

## Limitações conhecidas

- Ordem de publicação por agregado não é garantida entre publishers concorrentes (ver Mensageria).
- Métricas são por processo e em memória; agregar entre instâncias depende de um scraper.
- A fila não prova a identidade do produtor.
- Sem reversão parcial e sem ledger de partidas dobradas.
- Moeda operacional única (BRL), com o tipo preparado para recusar outra moeda.
- Keycloak em `start-dev`. O hostname do token é `localhost`, e o container da API busca o JWKS em `http://keycloak:8080` mantendo o `iss` em `http://localhost:8080/realms/jungle`.
- O teste de carga roda cliente, aplicação e infraestrutura na mesma máquina; os números são de ordem de grandeza ([docs/load-test.md](docs/load-test.md)).
- Em Windows, encerrar um processo filho é sempre abrupto: o shutdown gracioso por SIGTERM é testado in-process, não entre processos.
