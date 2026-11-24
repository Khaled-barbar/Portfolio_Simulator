"""Sets (or removes) the password that protects the site.

    python scripts/set_password.py                    site password (asks for it)
    python scripts/set_password.py --remove           no site password
    python scripts/set_password.py --admin            admin password (Admin menu: market briefing)
    python scripts/set_password.py --admin --remove   no admin password (the Admin menu stays locked)

Writes site/auth.json (or site/admin.json with --admin) with a salted PBKDF2-SHA256 hash; the
password itself is never stored.
Then commit and push (git commit -am "New password" && git push): the site is republished
automatically and every browser asks for the new password once.

The check runs in the visitor's browser (the site is static), so it keeps casual visitors and bots
out, but it is not bank-grade security.
"""
import getpass
import hashlib
import json
import secrets
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
ITER = 200_000


def make(password: str) -> dict:
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITER)
    return {"alg": "PBKDF2-SHA256", "iter": ITER, "salt": salt.hex(), "hash": h.hex()}


def main():
    AUTH = SITE / ("admin.json" if "--admin" in sys.argv else "auth.json")
    if "--remove" in sys.argv:
        AUTH.unlink(missing_ok=True)
        print("password removed — commit and push to publish")
        return
    p1 = getpass.getpass("New admin password: " if "--admin" in sys.argv else "New password: ")
    if len(p1) < 6:
        sys.exit("use at least 6 characters")
    if getpass.getpass("Repeat it: ") != p1:
        sys.exit("the two passwords differ")
    AUTH.write_text(json.dumps(make(p1), indent=1) + "\n", encoding="utf-8")
    print(f"written {AUTH} — commit and push to publish")


if __name__ == "__main__":
    main()
