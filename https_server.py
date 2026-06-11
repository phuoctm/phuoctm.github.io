"""Simple HTTPS dev server for local iteration."""
import functools, http.server, pathlib, ssl, subprocess, sys, time

PORT = 8443
ROOT = pathlib.Path(__file__).parent
CERT = ROOT / "localhost.crt"
KEY  = ROOT / "localhost.key"

if not CERT.exists() or not KEY.exists():
    print("Certificate not found. Run:  python generate_cert.py")
    sys.exit(1)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)

# Serve the project folder no matter what directory the server is started from.
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))


class DevServer(http.server.ThreadingHTTPServer):
    # Windows quirk: with allow_reuse_address (the http.server default) a
    # SECOND instance can bind the same port without any error, and the two
    # servers then fight over incoming connections. Fail loudly instead —
    # bind() below handles the failure.
    allow_reuse_address = False
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Routine connection noise — clients rejecting the self-signed cert,
        # dropped connections — gets one log line instead of a 30-line
        # traceback. Plain-HTTP probes against the TLS port (the preview
        # tool's health checks do this constantly) are silenced entirely.
        exc = sys.exc_info()[1]
        if isinstance(exc, ssl.SSLError) and "HTTP_REQUEST" in str(exc):
            return
        if isinstance(exc, (ssl.SSLError, ConnectionError, TimeoutError, OSError)):
            print(f"[conn] {client_address[0]}: {type(exc).__name__}: {exc}")
        else:
            super().handle_error(request, client_address)


def stop_previous_instance():
    """Free the port if (and only if) an older https_server.py is holding it.

    Anything else listening on the port is reported, never killed.
    Returns True if a previous instance was stopped.
    """
    find_pids = (
        f"Get-NetTCPConnection -LocalPort {PORT} -State Listen "
        "-ErrorAction SilentlyContinue | "
        "Select-Object -ExpandProperty OwningProcess -Unique"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", find_pids],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception:
        return False

    killed = False
    for pid in {int(p) for p in out.split() if p.strip().isdigit()}:
        get_cmdline = f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"
        try:
            cmdline = subprocess.run(
                ["powershell", "-NoProfile", "-Command", get_cmdline],
                capture_output=True, text=True, timeout=15,
            ).stdout.strip()
        except Exception:
            continue
        if "https_server.py" in cmdline:
            print(f"Port {PORT} held by a previous https_server.py (PID {pid}) — stopping it.")
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
            killed = True
        else:
            print(f"Port {PORT} is in use by another program (PID {pid}):")
            print(f"  {cmdline or '(command line unavailable)'}")
            print("Stop that process and try again.")
    return killed


def bind():
    try:
        return DevServer(("", PORT), handler)
    except OSError:
        if stop_previous_instance():
            time.sleep(1.0)
            return DevServer(("", PORT), handler)
        raise


with bind() as httpd:
    # ThreadingHTTPServer + deferred TLS handshake: browsers open speculative
    # extra connections; with a single thread (or with the handshake done in
    # the accept loop) one idle connection blocks every other request and the
    # page never loads. Deferring the handshake moves it into each
    # connection's own thread.
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True,
                                   do_handshake_on_connect=False)
    print(f"Serving HTTPS at https://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
