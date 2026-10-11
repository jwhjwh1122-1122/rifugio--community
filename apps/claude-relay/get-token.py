import os, json, time, base64, hashlib, secrets, subprocess, urllib.request, urllib.error, urllib.parse

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
REDIRECT = "https://platform.claude.com/oauth/code/callback"
HERE = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.join(HERE, "c4.txt")
TOKEN = os.path.join(HERE, "token.txt")

b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
verifier = b64(secrets.token_bytes(32))
challenge = b64(hashlib.sha256(verifier.encode()).digest())
state = b64(secrets.token_bytes(32))
url = "https://claude.com/cai/oauth/authorize?" + urllib.parse.urlencode({
    "code": "true", "client_id": CLIENT_ID, "response_type": "code",
    "redirect_uri": REDIRECT, "scope": "user:inference",
    "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
})
open(CODE, "w").close()
print("\nSTEP 1 - open this link:\n\n" + url + "\n\nSTEP 2 - paste code into c4.txt, close tab, Save\n", flush=True)
subprocess.run(["code", CODE])

while True:
    time.sleep(1)
    raw = open(CODE).read().strip()
    if len(raw) > 20:
        break
code, _, st = raw.partition("#")
print("code read, exchanging...", flush=True)
if st and st != state:
    print("WARNING: state does not match this run (old link?)", flush=True)

def exchange(with_expiry=True):
    body = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
            "client_id": CLIENT_ID, "code_verifier": verifier, "state": st or state}
    if with_expiry:
        body["expires_in"] = 31536000
    req = urllib.request.Request("https://platform.claude.com/v1/oauth/token",
                                 data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Accept": "application/json",
                                          "User-Agent": "claude-cli/2.1.296 (external, cli)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")
    except Exception as e:
        return 0, "network error: %r" % e

status, text = exchange(True)
print("\nHTTP", status, "\n" + text[:800], flush=True)
if status == 200:
    tok = json.loads(text).get("access_token", "")
    open(TOKEN, "w").write(tok + "\n")
    print("\n===== OK! TOKEN saved to token.txt =====\n" + tok, flush=True)
    subprocess.run(["code", TOKEN])
