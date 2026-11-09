"""One-shot, credential-free hosting experiment. No arbitrary URL or login API."""
import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from probe import classify

report = {'status': 'running', 'results': []}
lock = threading.Lock()


def run_probe():
    from playwright.sync_api import sync_playwright
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            try:
                for label, path in [('login', '/login/index.php'), ('mobile-launch', '/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=' + uuid.uuid4().hex + '&urlscheme=moodlemobile')]:
                    context = browser.new_context()
                    try:
                        page = context.new_page()
                        response = page.goto('https://moodle.runi.ac.il/2027' + path, wait_until='domcontentloaded', timeout=25000)
                        page.wait_for_timeout(5000)
                        results.append({'route': label, 'http_status': response.status if response else None, **classify(page.content())})
                    except Exception:
                        # Exception strings may contain redirect identifiers; do not log them.
                        results.append({'route': label, 'classification': 'navigation_error'})
                    finally:
                        context.close()
            finally:
                browser.close()
        status = 'complete'
    except Exception:
        status = 'browser_start_error'
    with lock:
        report.update(status=status, results=results)
    print(json.dumps(report), flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/', '/health'):
            self.send_error(404)
            return
        with lock:
            data = json.dumps({'ok': True} if self.path == '/health' else report).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    # Once per explicitly started process. Requests only read the result.
    threading.Thread(target=run_probe, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '10000'))), Handler).serve_forever()
