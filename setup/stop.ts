import { ok, requireDocker, run, step } from './lib';

// Para os containers sem removê-los: bun run setup (ou docker compose start) volta de onde parou.

step('Parando API, PostgreSQL, LocalStack e Keycloak');
requireDocker();
run(['docker', 'compose', '--profile', 'app', 'stop'], 'docker compose stop');
ok('Tudo parado. Containers e dados preservados.');
