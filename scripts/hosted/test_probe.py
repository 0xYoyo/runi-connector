import unittest
from probe import classify


class ProbeTests(unittest.TestCase):
    def test_password_form(self):
        self.assertEqual(classify('<input name="pw" type="password">')['classification'], 'login_signals')

    def test_challenge_takes_precedence(self):
        self.assertEqual(classify('<input type=password>Verify you are human')['classification'], 'challenge_signals')

    def test_script_only_challenge(self):
        html = '<html><head><meta charset="utf-8"></head><body><script src="/kramericaindustries.ac_v2.lib.js"></script><script>var rbz=1</script></body></html>'
        self.assertEqual(classify(html)["classification"], "challenge_signals")

    def test_unknown_page_is_not_success(self):
        self.assertEqual(classify('<h1>Welcome</h1>')['classification'], 'inconclusive')
        self.assertEqual(classify(None)['classification'], 'unexpected_response')

    def test_secrets_not_in_report(self):
        result = str(classify('<input type=password value="SECRET"><script>token="SECRET"</script>'))
        self.assertNotIn('SECRET', result)


if __name__ == '__main__':
    unittest.main()
