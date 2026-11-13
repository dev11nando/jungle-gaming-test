#!/bin/bash
exec 3<>/dev/tcp/127.0.0.1/9000 || exit 1
printf 'GET /health/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
grep -q '"status"[[:space:]]*:[[:space:]]*"UP"' <&3
