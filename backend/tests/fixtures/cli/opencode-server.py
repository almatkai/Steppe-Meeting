"""Executable fake OpenCode v2 protocol. Its legacy `run` path reproduces 429.

Tests prepend CAPTURE, EVENTS and MODE constants. No cloud or user database.
"""
import json
import base64
import os
from pathlib import Path
import queue
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
events = queue.Queue()
permission_replied = threading.Event()
session_id = 'ses_steppe_owned_test_session'

def record(kind, **values):
    with lock, Path(CAPTURE).open('a') as file:
        file.write(json.dumps({'kind': kind, **values}) + '\n')

record('start', pid=os.getpid(), argv=sys.argv[1:], cwd=os.getcwd(), pwd=os.environ.get('PWD'),
       nested=os.environ.get('OPENCODE_SESSION_ID'),
       config=json.loads(Path('opencode.json').read_text()))
if sys.argv[1] != 'serve':
    print(json.dumps({'type': 'error', 'error': {'type': 'provider.free-limit', 'status': 429}}))
    sys.exit(1)

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def reply(self, data=None, code=200):
        content = json.dumps(data).encode() if data is not None else b''
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def authenticated(self):
        expected = 'Basic ' + base64.b64encode(('opencode:' + os.environ['OPENCODE_PASSWORD']).encode()).decode()
        if self.headers.get('Authorization') != expected:
            self.reply({}, 401)
            return False
        return True

    def do_GET(self):
        if not self.authenticated(): return
        if self.path == '/api/info':
            self.reply({'version': '2.1.4', 'pid': os.getpid()})
        elif self.path == '/api/event':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            self.wfile.flush()
            while True:
                event = events.get()
                try:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
                if event.get('type', '').startswith('session.execution.'):
                    break
        else:
            self.reply({}, 404)

    def do_POST(self):
        global session_id
        if not self.authenticated(): return
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        record('request', method='POST', path=self.path, body=body)
        if self.path == '/api/session':
            if 'id' in body:
                self.reply({'error': 'must use a native identity'}, 400)
                return
            import uuid
            session_id = 'ses_' + uuid.uuid4().hex[:26]
            self.reply({'data': {'id': session_id}})
        elif self.path.endswith('/prompt'):
            if MODE == 'prompt-error':
                self.reply({}, 500)
                return
            if MODE != 'wait-for-permission':
                self.reply({'data': {}})
            for event in EVENTS:
                if event.get('data', {}).get('sessionID') == 'ses_steppe_owned_test_session':
                    event['data']['sessionID'] = session_id
                events.put(event)
            if MODE == 'wait-for-permission':
                self.reply({'data': {}}, 200 if permission_replied.wait(2) else 408)
        elif '/permission/' in self.path:
            self.reply(None, 204)
            permission_replied.set()
            events.put({'type': 'session.execution.succeeded', 'data': {'sessionID': session_id}})
        elif self.path.endswith('/interrupt'):
            self.reply(None, 500 if MODE == 'cleanup-error' else 204)
        else:
            self.reply({}, 404)

    def do_DELETE(self):
        if not self.authenticated(): return
        record('request', method='DELETE', path=self.path)
        self.reply(None, 500 if MODE == 'cleanup-error' else 204)

class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer.server_bind does a reverse DNS lookup for server_name.
        # This offline fixture needs only its numeric loopback address; macOS
        # CI DNS can stall for 35 seconds before the listener becomes usable.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address


port = int(next(a.split('=')[1] for a in sys.argv if a.startswith('--port=')))
server = LoopbackServer(('127.0.0.1', port), Handler)
server.daemon_threads = True
server.serve_forever()
