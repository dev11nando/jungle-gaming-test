import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../../config/app-config';

export function createSqsClient(config: Pick<SqsConfig, 'endpoint' | 'region'>): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 3,
  });
}

export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client: SQSClient) {}

  get(name: string): Promise<string> {
    let url = this.cache.get(name);
    if (url === undefined) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => {
        if (!r.QueueUrl) throw new Error(`queue ${name} not found`);
        return r.QueueUrl;
      });
      url.catch(() => this.cache.delete(name));
      this.cache.set(name, url);
    }
    return url;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
