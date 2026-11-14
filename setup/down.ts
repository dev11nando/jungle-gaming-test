import { hasFlag, ok, requireDocker, run, step, warn } from './lib';

// Uso: bun run down             remove containers e rede (dados do PostgreSQL preservados)
//      bun run down --volumes   remove também os dados (banco, realm do Keycloak)

const wipe = hasFlag('--volumes');

step(wipe ? 'Removendo containers, rede e dados' : 'Removendo containers e rede');
requireDocker();
run(['docker', 'compose', '--profile', 'app', 'down', '--remove-orphans', ...(wipe ? ['--volumes'] : [])], 'docker compose down');
if (wipe) {
  warn('Volumes apagados: o próximo bun run setup recria o banco e reimporta o realm do zero.');
} else {
  ok('Containers removidos. Dados preservados no volume do PostgreSQL.');
}
