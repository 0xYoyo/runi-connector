"""Credential-free cloud browser reachability probe. Never prints HTML or tokens.

Run only after confirming the account's plan/budget. Uses an existing Wrangler
OAuth login or CLOUDFLARE_API_TOKEN. Does not deploy or change subscriptions.
"""
import argparse
import json
import os
import pathlib
import re
import tomllib
import urllib.error
import urllib.request

API = 'https://api.cloudflare.com/client/v4'
TARGET = 'https://moodle.runi.ac.il/2027/login/index.php'


def classify(html):
    """Signals, not proof of successful authentication or absence of blocking."""
    if not isinstance(html, str):
        return {'classification': 'unexpected_response'}
    challenge = bool(re.search(r'checking your browser|verify you are human|access denied|captcha|rbzid|reblaze', html, re.I))
    password = bool(re.search(r'<input\b[^>]*\btype\s*=\s*[\"\x27]?password', html, re.I))
    saml = bool(re.search(r'SAMLRequest|SAMLResponse|auth\.runi\.ac\.il|my\.runi\.ac\.il', html, re.I))
    return {'classification': 'challenge_signals' if challenge else 'login_signals' if password or saml else 'inconclusive',
            'password_form': password, 'sso_signals': saml, 'challenge_signals': challenge,
            'html_bytes': len(html.encode('utf-8'))}


def token():
    value = os.environ.get('CLOUDFLARE_API_TOKEN')
    if value:
        return value
    candidates = [pathlib.Path.home() / 'Library/Preferences/.wrangler/config/default.toml',
                  pathlib.Path.home() / '.wrangler/config/default.toml']
    for path in candidates:
        if path.exists():
            value = tomllib.loads(path.read_text()).get('oauth_token')
            if value:
                return value
    raise RuntimeError('Sign in with Wrangler or supply CLOUDFLARE_API_TOKEN.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--confirm-browser-budget', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-fA-F0-9]{32}', args.account_id):
        parser.error('account-id must be a 32-character Cloudflare account ID')
    if not args.confirm_browser_budget:
        parser.error('Confirm the free allowance or authorized budget before passing --confirm-browser-budget')
    body = {'url': TARGET, 'gotoOptions': {'waitUntil': 'networkidle2', 'timeout': 20000}}
    request = urllib.request.Request(f'{API}/accounts/{args.account_id}/browser-rendering/content',
        data=json.dumps(body).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            data = json.load(response)
            result = data.get('result')
            # API revisions may wrap content; unknown response shapes are inconclusive.
            html = result if isinstance(result, str) else result.get('content') if isinstance(result, dict) else None
            print(json.dumps({'provider': 'cloudflare-browser', 'target': TARGET,
                'api_success': data.get('success'), **classify(html)}, indent=2))
    except urllib.error.HTTPError as error:
        # Do not emit response bodies, headers or request objects containing secrets.
        print(json.dumps({'provider': 'cloudflare-browser', 'api_http_status': error.code,
                          'classification': 'provider_error'}))
        raise SystemExit(1)
    except (urllib.error.URLError, TimeoutError, ValueError):
        print(json.dumps({'classification': 'network_or_response_error'}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
