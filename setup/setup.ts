import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dim, envFileExists, hasFlag, INFRA, ok, requireDocker, ROOT, run, step, waitHealthy, waitHttp } from './lib';

// Uso: bun run setup            infra + migrations + API no Docker
//      bun run setup --infra    só infra + migrations (para rodar a API com bun run start:dev)

async function main(): Promise<void> {
  const infraOnly = hasFlag('--infra');
  const started = Date.now();

  step('Pré-requisitos');
  requireDocker();
  ok(`Bun ${Bun.version} e Docker rodando`);

  step('Configuração');
  if (envFileExists()) {
    ok('.env já existe (mantido)');
  } else {
    copyFileSync(resolve(ROOT, '.env.example'), resolve(ROOT, '.env'));
    ok('.env criado a partir do .env.example');
  }

  step('Dependências');
  run(['bun', 'install', '--frozen-lockfile'], 'bun install');

  step('Subindo PostgreSQL, LocalStack (SQS) e Keycloak');
  console.log(dim('  na primeira vez as imagens são baixadas e o Keycloak leva ~1 min'));
  run(['docker', 'compose', 'up', '-d', ...INFRA], 'docker compose up');
  await waitHealthy(INFRA, 240_000);

  step('Migrations');
  run(['bun', 'src/infra/database/migrate.ts', 'up'], 'migrations');

  if (infraOnly) {
    step('Infra pronta');
    console.log(`  Suba a API no host com: ${dim('bun run start:dev')}`);
  } else {
    step('Subindo a API (HTTP + consumidor SQS + outbox + pendências)');
    run(['docker', 'compose', '--profile', 'app', 'up', '-d', '--build', 'api'], 'build/subida da API');
    const ready = await waitHttp('http://localhost:3000/health/ready', 120_000);
    ok(`API pronta: ${ready}`);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const line = '─'.repeat(60);
  console.log(
    [
      '',
      line,
      `Tudo no ar em ${seconds}s.`,
      '',
      `  API         http://localhost:3000   ${infraOnly ? dim('(suba com bun run start:dev)') : ''}`,
      '  Health      http://localhost:3000/health/ready',
      '  Métricas    http://localhost:3000/metrics',
      '  Keycloak    http://localhost:8080   (admin / admin)',
      '  PostgreSQL  localhost:5432          (wagering / wagering)',
      '  SQS         http://localhost:4566   (LocalStack)',
      '',
      '  Token de provedor (client provider-a):',
      '    curl -s -X POST http://localhost:8080/realms/jungle/protocol/openid-connect/token \\',
      '      -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret',
      '',
      '  Testes:     bun run test:all',
      '  Parar:      bun run stop',
      '  Derrubar:   bun run down     (bun run down --volumes apaga os dados)',
      line,
    ].join('\n'),
  );
}

void main();
