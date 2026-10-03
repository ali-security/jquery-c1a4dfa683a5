#!/usr/bin/env bash
#
# Start nginx + PHP-FPM serving the repository root on 127.0.0.1:<port> so the
# QUnit suite (test/index.html) and its PHP fixtures (test/data/*.php) can run
# in a headless browser (see test/run-qunit.js).
#
# PHP's built-in server (php -S) is not used: it intermittently drops requests
# when PhantomJS opens several connections at once, which hangs the ajax tests,
# and it serialises requests, which breaks the fixtures that deliberately sleep.
#
# Usage: test/start-test-server.sh [port]    (default 8000)
# Logs and generated config live in $TEST_SERVER_DIR (default /tmp/jquery-test-server).

set -euo pipefail

PORT="${1:-8000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${TEST_SERVER_DIR:-/tmp/jquery-test-server}"
FPM_SOCKET="$DIR/php-fpm.sock"

# Prefer the php-fpm that belongs to the `php` on PATH (phpenv on Travis),
# then any php-fpm installed on the system.
FPM=""
if command -v php >/dev/null 2>&1; then
	candidate="$(dirname "$(php -r 'echo PHP_BINARY;')")/../sbin/php-fpm"
	if [ -x "$candidate" ]; then
		FPM="$candidate"
	fi
fi
if [ -z "$FPM" ]; then
	FPM="$(command -v php-fpm || ls /usr/sbin/php-fpm* 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [ -z "$FPM" ] || [ ! -x "$FPM" ]; then
	echo "ERROR: php-fpm not found" >&2
	exit 1
fi
NGINX="$(command -v nginx || echo /usr/sbin/nginx)"
if [ ! -x "$NGINX" ]; then
	echo "ERROR: nginx not found" >&2
	exit 1
fi
FASTCGI_PARAMS=/etc/nginx/fastcgi_params
MIME_TYPES=/etc/nginx/mime.types

mkdir -p "$DIR"

cat > "$DIR/php-fpm.conf" <<EOF
[global]
pid = $DIR/php-fpm.pid
error_log = $DIR/php-fpm.log
daemonize = yes

[www]
listen = $FPM_SOCKET
; Several fixtures sleep (up to 30s) on purpose; keep enough workers free.
pm = static
pm.max_children = 16
catch_workers_output = yes
EOF

cat > "$DIR/nginx.conf" <<EOF
worker_processes 2;
pid $DIR/nginx.pid;
error_log $DIR/nginx-error.log;
events { worker_connections 1024; }
http {
	include $MIME_TYPES;
	default_type application/octet-stream;
	access_log $DIR/nginx-access.log;
	# PhantomJS 2.1.1 (QtWebKit) intermittently stalls requests it queues on a
	# reused keep-alive connection; force one connection per request.
	keepalive_timeout 0;
	sendfile off;
	client_body_temp_path $DIR/client_body;
	proxy_temp_path $DIR/proxy;
	fastcgi_temp_path $DIR/fastcgi;
	uwsgi_temp_path $DIR/uwsgi;
	scgi_temp_path $DIR/scgi;

	server {
		listen 127.0.0.1:$PORT;
		root $ROOT;
		index index.html;

		location / {
			# Like Apache and php -S, answer POSTs to static fixtures
			# (e.g. jQuery.post( "data/name.html" )) instead of a 405
			error_page 405 =200 \$uri;
		}

		location ~ \.php(/|\$) {
			# Support REST-like fixture URLs such as data/jsonp.php/callbackName
			fastcgi_split_path_info ^(.+?\.php)(/.*)\$;
			if (!-f \$document_root\$fastcgi_script_name) {
				return 404;
			}
			include $FASTCGI_PARAMS;
			fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
			fastcgi_param PATH_INFO \$fastcgi_path_info;
			fastcgi_pass unix:$FPM_SOCKET;
		}
	}
}
EOF

echo "Using $("$FPM" -v | head -n 1)"
echo "Using $("$NGINX" -v 2>&1)"

"$FPM" -y "$DIR/php-fpm.conf"
"$NGINX" -c "$DIR/nginx.conf"

# Wait until both static files and PHP respond.
for i in $(seq 1 30); do
	if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/test/index.html" &&
		[ "$(curl -fsS "http://127.0.0.1:$PORT/test/data/name.php?name=foo")" = "bar" ]; then
		echo "Test server ready on http://127.0.0.1:$PORT/ (root $ROOT)"
		exit 0
	fi
	sleep 1
done

echo "ERROR: test server did not come up" >&2
cat "$DIR/php-fpm.log" "$DIR/nginx-error.log" >&2
exit 1
