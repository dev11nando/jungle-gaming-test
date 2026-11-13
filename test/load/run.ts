import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { ClusterNode, freePort, startJwksServer } from '../support/cluster';
import { resetSchema, testPool } from '../support/database';
import { createTestQueues, queueDepth, testSqsClient } from '../support/sqs';

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const DURATION_S = env('LOAD_DURATION_S', 30);
const CONCURRENCY = env('LOAD_CONCURRENCY', 64);
const NODES = env('LOAD_NODES', 3);
const WALLETS = env('LOAD_WALLETS', 100);
const SQS_MESSAGES = env('LOAD_SQS_MESSAGES', 3000);
const DB_URL = process.env.LOAD_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_load';
const HOT_BALANCE = process.env.LOAD_HOT_BALANCE ?? '100.00';
const REPORT = process.env.LOAD_REPORT ?? 'docs/load-test-results.md';

type Op = 'bet' | 'win' | 'replay' | 'hot-bet' | 'refund';
interface Sample {
  op: Op;
  status: number;
  ms: number;
}

const pct = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
const fmt = (n: number, d = 1) => n.toFixed(d);
const cents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const rand = (n: number) => Math.floor(Math.random() * n);

async function main(): Promise<void> {
  const orm = await resetSchema(DB_URL);
  const pool = testPool(DB_URL);
  const sqs = testSqsClient();
  const queues = await createTestQueues(sqs);
  const jwks = await startJwksServer();
  const token = await jwks.token();
  const nodes: ClusterNode[] = [];
  for (let i = 0; i < NODES; i += 1) {
    nodes.push(new ClusterNode({ id: `load-${i}`, port: await freePort(), databaseUrl: DB_URL, jwksUri: jwks.url, queues }));
  }
  await Promise.all(nodes.map((n) => n.start()));
  console.log(`cluster up: ${NODES} nodes`);

  const headers = (key?: string) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(key ? { 'idempotency-key': key } : {}),
  });
  let rr = 0;
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const node = nodes[rr++ % nodes.length] as ClusterNode;
    const res = await fetch(`${node.baseUrl}${path}`, { method, headers: headers(key), body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };

  const wallets: { walletId: string; playerId: string }[] = [];
  for (let i = 0; i < WALLETS; i += 1) {
    const playerId = randomUUID();
    const r = await call('POST', '/wallets', { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } });
    wallets.push({ walletId: r.body.id, playerId });
  }
  const hotPlayer = randomUUID();
  const hot = { walletId: (await call('POST', '/wallets', { playerId: hotPlayer, initialBalance: { amount: HOT_BALANCE, currency: 'BRL' } })).body.id, playerId: hotPlayer };

  const sent: { body: Record<string, unknown>; key: string }[] = [];
  const processedBets: Record<string, unknown>[] = [];
  const samples: Sample[] = [];
  const outboxSamples: { pending: number; lag: number }[] = [];
  let seq = 0;

  const wager = (w: { walletId: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) => ({
    providerId: 'provider-a',
    externalTransactionId: `load-${++seq}-${randomUUID().slice(0, 8)}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: `round-${seq}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  });

  const pickOp = (): Op => {
    const r = Math.random();
    if (r < 0.6) return 'bet';
    if (r < 0.7) return 'win';
    if (r < 0.8) return sent.length > 0 ? 'replay' : 'bet';
    if (r < 0.9) return 'hot-bet';
    return processedBets.length > 0 ? 'refund' : 'bet';
  };

  const deadline = Date.now() + DURATION_S * 1000;
  const sampler = setInterval(async () => {
    let pending = 0;
    let lag = 0;
    for (const n of nodes) {
      const text = await fetch(`${n.baseUrl}/metrics`).then((r) => r.text()).catch(() => '');
      pending = Math.max(pending, Number(/^wagering_outbox_pending (\S+)/m.exec(text)?.[1] ?? 0));
      lag = Math.max(lag, Number(/^wagering_outbox_lag_seconds (\S+)/m.exec(text)?.[1] ?? 0));
    }
    outboxSamples.push({ pending, lag });
  }, 1_000);

  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const op = pickOp();
        let body: Record<string, unknown>;
        let key: string;
        if (op === 'replay') {
          const prev = sent[rand(sent.length)] as { body: Record<string, unknown>; key: string };
          body = prev.body;
          key = prev.key;
        } else if (op === 'refund') {
          const bet = processedBets[rand(processedBets.length)] as Record<string, unknown>;
          const owner = wallets.find((w) => w.walletId === bet.walletId) ?? hot;
          body = wager(owner, 'REFUND', (bet.money as { amount: string }).amount, {
            referenceExternalTransactionId: bet.externalTransactionId,
            roundId: bet.roundId,
          });
          key = `provider-a:${String(body.externalTransactionId)}`;
        } else {
          const w = op === 'hot-bet' ? hot : (wallets[rand(wallets.length)] as { walletId: string; playerId: string });
          body = wager(w, op === 'win' ? 'WIN' : 'BET', op === 'hot-bet' ? '1.00' : cents(100 + rand(400)));
          key = `provider-a:${String(body.externalTransactionId)}`;
        }
        const t0 = performance.now();
        let status = 0;
        try {
          const res = await call('POST', '/wagering/transactions', body, key);
          status = res.status;
          if (op !== 'replay' && status < 500) sent.push({ body, key });
          if (op === 'bet' && status === 200) processedBets.push(body);
        } catch {
          status = -1;
        }
        samples.push({ op, status, ms: performance.now() - t0 });
      }
    }),
  );
  const httpSeconds = (performance.now() - started) / 1000;
  console.log(`http phase done: ${samples.length} requests`);

  // Fase SQS: lote enviado de uma vez; mede o tempo até todas as transações existirem.
  const sqsSent = new Map<string, number>();
  const batches: Promise<unknown>[] = [];
  const sqsStart = performance.now();
  for (let i = 0; i < SQS_MESSAGES; i += 10) {
    const entries = Array.from({ length: Math.min(10, SQS_MESSAGES - i) }, (_, j) => {
      const w = wallets[rand(wallets.length)] as { walletId: string; playerId: string };
      const data = { ...wager(w, 'BET', cents(100 + rand(400))), idempotencyKey: '' };
      data.idempotencyKey = `provider-a:${data.externalTransactionId}`;
      sqsSent.set(data.externalTransactionId, Date.now());
      const messageId = `m-${randomUUID()}`;
      return {
        Id: String(j),
        MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
        MessageGroupId: w.walletId,
        MessageDeduplicationId: messageId,
      };
    });
    batches.push(sqs.send(new SendMessageBatchCommand({ QueueUrl: queues.queueUrl, Entries: entries })));
  }
  await Promise.all(batches);
  const ids = [...sqsSent.keys()];
  for (;;) {
    const { rows } = await pool.query(`select count(*)::int as n from wager_transactions where external_transaction_id = any($1)`, [ids]);
    if (rows[0].n === ids.length && (await queueDepth(sqs, queues.queueUrl)) === 0) break;
    await Bun.sleep(250);
  }
  const sqsSeconds = (performance.now() - sqsStart) / 1000;
  const sqsLat = (
    await pool.query<{ ext: string; done: Date }>(
      `select external_transaction_id as ext, completed_at as done from wager_transactions where external_transaction_id = any($1)`,
      [ids],
    )
  ).rows.map((r) => new Date(r.done).getTime() - (sqsSent.get(r.ext) ?? 0));
  console.log(`sqs phase done in ${fmt(sqsSeconds)}s`);

  for (;;) {
    const { rows } = await pool.query(`select count(*)::int as n from outbox_messages where published_at is null`);
    if (rows[0].n === 0) break;
    await Bun.sleep(250);
  }
  clearInterval(sampler);

  const delays = (
    await pool.query<{ s: string }>(`select extract(epoch from published_at - occurred_at)::text as s from outbox_messages`)
  ).rows.map((r) => Number(r.s) * 1000);
  const metricsText = (await Promise.all(nodes.map((n) => fetch(`${n.baseUrl}/metrics`).then((r) => r.text())))).join('\n');
  const sumMetric = (name: string) =>
    [...metricsText.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)`, 'gm'))].reduce((a, m) => a + Number(m[1]), 0);

  const divergent = (
    await pool.query(
      `select count(*)::int as n from wallets w
        where w.balance_amount <> coalesce((select sum(case direction when 'CREDIT' then amount else -amount end)
                                             from wallet_ledger_entries e where e.wallet_id = w.id), 0)`,
    )
  ).rows[0].n;
  const counts = (await pool.query(`select status, count(*)::int as n from wager_transactions where kind <> 'OPENING' group by status`)).rows;

  await Promise.all(nodes.map((n) => n.kill()));
  jwks.stop();
  sqs.destroy();
  await pool.end();
  await orm.close(true);

  const lat = samples.filter((s) => s.status > 0).map((s) => s.ms);
  const byStatus = new Map<number, number>();
  for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const errors = samples.filter((s) => s.status >= 500 || s.status < 0).length;
  const opRows = (['bet', 'win', 'replay', 'hot-bet', 'refund'] as Op[]).map((op) => {
    const xs = samples.filter((s) => s.op === op);
    const ms = xs.map((s) => s.ms);
    const st = [...new Set(xs.map((s) => s.status))].sort().map((code) => `${code}: ${xs.filter((s) => s.status === code).length}`);
    return `| ${op} | ${xs.length} | ${fmt(pct(ms, 50))} | ${fmt(pct(ms, 95))} | ${fmt(pct(ms, 99))} | ${st.join(', ')} |`;
  });

  const report = `# Resultados do teste de carga (gerado por \`bun run test:load\`)

Execução: ${new Date().toISOString()}

## Ambiente

| | |
| --- | --- |
| Máquina | ${os.cpus()[0]?.model.trim()} · ${os.cpus().length} threads · ${Math.round(os.totalmem() / 2 ** 30)} GB · ${os.platform()} ${os.release()} |
| Runtime | Bun ${Bun.version} |
| Infra | PostgreSQL 16 e LocalStack 4 em Docker Desktop (WSL2), mesma máquina |
| Instâncias | ${NODES} processos \`bun src/main.ts\` (HTTP + consumer + outbox + pending-reference), pool de 10 conexões cada |

## Parâmetros

Duração HTTP ${DURATION_S}s · ${CONCURRENCY} clientes concorrentes · ${WALLETS} wallets normais + 1 wallet quente (${HOT_BALANCE}) · ${SQS_MESSAGES} mensagens SQS.
Mix HTTP: 60% BET, 10% WIN, 10% replay de requisição já enviada, 10% BET de 1.00 na wallet quente, 10% REFUND de BET aceita.

## HTTP — POST /wagering/transactions

| Métrica | Valor |
| --- | --- |
| Requisições | ${samples.length} |
| Throughput | ${fmt(samples.length / httpSeconds)} req/s |
| Latência p50 / p95 / p99 | ${fmt(pct(lat, 50))} / ${fmt(pct(lat, 95))} / ${fmt(pct(lat, 99))} ms |
| Erros (5xx ou falha de rede) | ${errors} (${fmt((100 * errors) / Math.max(1, samples.length), 2)}%) |
| Status | ${[...byStatus.entries()].sort().map(([k, v]) => `${k}: ${v}`).join(' · ')} |

| Operação | n | p50 ms | p95 ms | p99 ms | status |
| --- | --- | --- | --- | --- | --- |
${opRows.join('\n')}

## SQS

| Métrica | Valor |
| --- | --- |
| Mensagens | ${SQS_MESSAGES} |
| Tempo até todas aplicadas | ${fmt(sqsSeconds)} s |
| Throughput | ${fmt(SQS_MESSAGES / sqsSeconds)} msg/s |
| Latência envio → commit p50 / p95 / p99 | ${fmt(pct(sqsLat, 50), 0)} / ${fmt(pct(sqsLat, 95), 0)} / ${fmt(pct(sqsLat, 99), 0)} ms |

## Concorrência e outbox

| Métrica | Valor |
| --- | --- |
| Conflitos de lock (\`wagering_lock_conflicts_total\`) | ${sumMetric('wagering_lock_conflicts_total')} |
| Retries de corrida de unicidade / SQS | ${sumMetric('wagering_retries_total')} |
| Duplicatas detectadas | ${sumMetric('wagering_duplicates_total')} |
| Outbox: eventos publicados | ${delays.length} |
| Outbox: commit → publicação p50 / p95 / p99 | ${fmt(pct(delays, 50), 0)} / ${fmt(pct(delays, 95), 0)} / ${fmt(pct(delays, 99), 0)} ms |
| Outbox: pendentes máx. amostrado | ${Math.max(0, ...outboxSamples.map((s) => s.pending))} |
| Outbox: idade máx. do pendente mais antigo | ${fmt(Math.max(0, ...outboxSamples.map((s) => s.lag)), 2)} s |

## Invariantes no fim

| | |
| --- | --- |
| Wallets com saldo ≠ ledger | ${divergent} |
| Transações por status | ${counts.map((c) => `${c.status}: ${c.n}`).join(' · ')} |
`;
  writeFileSync(REPORT, report);
  console.log(report);
  if (divergent !== 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
