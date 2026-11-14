import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/entities/outbox-message';

export interface ClaimedOutboxMessage {
  message: OutboxMessage;
  position: string;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  position: string;
}

export class OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  // Reserva curta (lease): a transação termina antes da chamada de rede ao SQS.
  async claim(workerId: string, limit: number, leaseSeconds: number): Promise<ClaimedOutboxMessage[]> {
    const rows = await this.orm.em.fork().execute<OutboxRow[]>(
      `with due as (
         select id from outbox_messages
          where published_at is null
            and next_attempt_at <= now()
            and (locked_until is null or locked_until < now())
          order by position
          limit ?
          for update skip locked
       )
       update outbox_messages o
          set locked_by = ?, locked_until = now() + make_interval(secs => ?)
         from due
        where o.id = due.id
       returning o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at,
                 o.position::text as position`,
      [limit, workerId, leaseSeconds],
    );
    return rows
      .sort((a, b) => (BigInt(a.position) < BigInt(b.position) ? -1 : 1))
      .map((r) => ({
        position: r.position,
        message: OutboxMessage.rehydrate({
          id: r.id,
          aggregateId: r.aggregate_id,
          eventType: r.event_type,
          payload: r.payload,
          occurredAt: new Date(r.occurred_at),
          attempts: r.attempts,
          nextAttemptAt: new Date(r.next_attempt_at),
        }),
      }));
  }

  async markPublished(ids: readonly string[], workerId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const res = await this.orm.em.fork().execute<{ affectedRows?: number }>(
      `update outbox_messages
          set published_at = now(), locked_by = null, locked_until = null
        where id in (${placeholders}) and published_at is null and locked_by = ?`,
      [...ids, workerId],
      'run',
    );
    return res.affectedRows ?? 0;
  }

  async markFailed(message: OutboxMessage, workerId: string, error: string, now: Date): Promise<void> {
    message.scheduleRetry(now);
    await this.orm.em.fork().execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = null, locked_until = null
        where id = ? and published_at is null and locked_by = ?`,
      [message.attempts, message.nextAttemptAt, error.slice(0, 512), message.id, workerId],
      'run',
    );
  }

  async backlog(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await this.orm.em.fork().execute<{ pending: number; oldest: string | null }[]>(
      `select count(*)::int as pending, extract(epoch from now() - min(occurred_at))::text as oldest
         from outbox_messages where published_at is null`,
    );
    const row = rows[0];
    return { pending: row?.pending ?? 0, oldestAgeSeconds: row?.oldest ? Number(row.oldest) : 0 };
  }
}
