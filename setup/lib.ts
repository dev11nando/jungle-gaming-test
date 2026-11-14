import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(__dirname, '..');
export const INFRA = ['postgres', 'localstack', 'keycloak'] as const;

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = color(32);
export const yellow = color(33);
export const red = color(31);
export const dim = color(2);

export const step = (text: string) => console.log(`\n${green('▸')} ${text}`);
export const ok = (text: string) => console.log(`  ${green('✓')} ${text}`);
export const warn = (text: string) => console.log(`  ${yellow('!')} ${text}`);

export function fail(text: string): never {
  console.error(`\n${red('✗')} ${text}`);
  process.exit(1);
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** Roda um comando mostrando a saída; aborta o setup se falhar. */
export function run(cmd: string[], what: string): void {
  const res = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  if (res.exitCode !== 0) fail(`${what} falhou (${cmd.join(' ')})`);
}

/** Roda um comando em silêncio e devolve a saída. */
export function capture(cmd: string[]): { code: number; out: string } {
  try {
    const res = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    return { code: res.exitCode ?? 1, out: `${res.stdout.toString()}${res.stderr.toString()}` };
  } catch {
    return { code: 127, out: `${cmd[0]} não encontrado` };
  }
}

export function requireDocker(): void {
  if (capture(['docker', '--version']).code !== 0) {
    fail('Docker não encontrado. Instale o Docker Desktop (ou Docker Engine + Compose v2).');
  }
  if (capture(['docker', 'info']).code !== 0) {
    fail('O Docker está instalado, mas não está rodando. Abra o Docker Desktop e tente de novo.');
  }
  if (capture(['docker', 'compose', 'version']).code !== 0) {
    fail('Docker Compose v2 não encontrado (comando "docker compose").');
  }
}

interface ServiceState {
  Service: string;
  State: string;
  Health: string;
}

function services(): ServiceState[] {
  const { out } = capture(['docker', 'compose', '--profile', 'app', 'ps', '--all', '--format', 'json']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as ServiceState);
}

export async function waitHealthy(names: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const done = new Set<string>();
  while (done.size < names.length) {
    const states = services();
    for (const name of names) {
      const s = states.find((x) => x.Service === name);
      if (done.has(name) || s === undefined) continue;
      if (s.State === 'exited' || s.State === 'dead') {
        fail(`${name} parou inesperadamente. Veja os logs: docker compose logs ${name}`);
      }
      if (s.Health === 'healthy' || (s.Health === '' && s.State === 'running')) {
        done.add(name);
        ok(`${name} pronto`);
      }
    }
    if (done.size === names.length) return;
    if (Date.now() > deadline) {
      const pending = names.filter((n) => !done.has(n));
      fail(`Tempo esgotado esperando ${pending.join(', ')}. Veja: docker compose logs ${pending.join(' ')}`);
    }
    await Bun.sleep(2_000);
  }
}

export async function waitHttp(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      last = await res.text();
      if (res.ok) return last;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(1_000);
  }
  fail(`A API não ficou pronta em ${url}. Última resposta: ${last || 'nenhuma'}. Veja: docker compose logs api`);
}

export function envFileExists(): boolean {
  return existsSync(resolve(ROOT, '.env'));
}
