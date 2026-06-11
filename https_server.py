"""Simple HTTPS dev server for local iteration."""
import ssl, http.server, pathlib, sys

PORT = 8443
ROOT = pathlib.Path(__file__).parent
CERT = ROOT / "localhost.crt"
KEY  = ROOT / "localhost.key"

if not CERT.exists() or not KEY.exists():
    print("Certificate not found. Run:  python generate_cert.py")
    sys.exit(1)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)

handler = http.server.SimpleHTTPRequestHandler
handler.directory = str(ROOT)

with http.server.HTTPServer(("", PORT), handler) as httpd:
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"Serving HTTPS at https://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    httpd.serve_forever()
