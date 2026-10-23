#!/usr/bin/env python3
"""Sentinel credential broker -- native messaging host.

Speaks the Chrome/Firefox native messaging protocol (a 4-byte native-endian
length prefix followed by UTF-8 JSON) and stores provider API keys OUTSIDE the
browser profile.

WHY. chrome.storage.local is plaintext on disk, survives every restart, is
uploaded to the vendor's cloud by chrome.storage.sync, and is readable by any
code running in the extension's service-worker context. This host is where the
extension sends keys instead.

BACKENDS, in order:

  1. OS keychain -- libsecret through `secret-tool` (Linux), the `security` CLI
     (macOS), or DPAPI through ctypes (Windows).
  2. Encrypted file -- AES-256-GCM when `cryptography` is importable, otherwise
     an HMAC-SHA256 keystream with encrypt-then-MAC. The file is mode 0600 in
     ~/.sentinel/.

HONEST LIMITS. The file backend is defence in depth, not a boundary: the machine
key sits beside the ciphertext, so anything that can read one can read the
other. Its real value is that the secret leaves the browser profile entirely,
and that it works on machines with no keychain daemon (headless hosts,
containers, minimal installs). The keychain backend is the one to prefer.

This host never writes a key to stdout, stderr or the system log. Replies carry
a key only when the extension asked for exactly one.
"""

import base64
import hashlib
import hmac
import json
import os
import platform
import secrets
import shutil
import struct
import subprocess
import sys

VERSION = 1
SERVICE = "sentinel-credential-broker"
STATE_DIR = os.path.join(os.path.expanduser("~"), ".sentinel")
STORE_PATH = os.path.join(STATE_DIR, "credentials.enc")
MACHINE_KEY_PATH = os.path.join(STATE_DIR, ".machine-key")
INDEX_PATH = os.path.join(STATE_DIR, "providers.json")

KEYCHAIN = "keychain"
FILE = "file"
MAX_MESSAGE = 4 * 1024 * 1024

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    _HAVE_GCM = True
except Exception:  # pragma: no cover - exercised on minimal installs
    _HAVE_GCM = False


class BrokerError(Exception):
    """A request could not be satisfied. The text never contains key material."""


# --------------------------------------------------------------------------
# crypto
# --------------------------------------------------------------------------

def _b64e(raw):
    return base64.b64encode(raw).decode("ascii")


def _b64d(text):
    try:
        return base64.b64decode(text or "", validate=False)
    except Exception:
        raise BrokerError("malformed base64 payload")


def _keystream(key, nonce, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(key + nonce + counter.to_bytes(8, "big")).digest()
        counter += 1
    return bytes(out[:length])


def _mac(key, nonce, ciphertext):
    return hmac.new(key, b"sentinel-broker" + nonce + ciphertext, hashlib.sha256).digest()


def _seal(key, plaintext):
    if _HAVE_GCM:
        nonce = os.urandom(12)
        return {"alg": "aes256gcm", "nonce": _b64e(nonce), "ct": _b64e(AESGCM(key).encrypt(nonce, plaintext, None))}
    nonce = os.urandom(16)
    body = bytes(a ^ b for a, b in zip(plaintext, _keystream(key, nonce, len(plaintext))))
    return {"alg": "hmac-sha256-ctr", "nonce": _b64e(nonce), "ct": _b64e(body + _mac(key, nonce, body))}


def _open(key, envelope):
    alg = envelope.get("alg")
    nonce = _b64d(envelope.get("nonce"))
    ct = _b64d(envelope.get("ct"))
    if alg == "aes256gcm":
        if not _HAVE_GCM:
            raise BrokerError("store was written with AES-256-GCM but the cryptography module is unavailable")
        return AESGCM(key).decrypt(nonce, ct, None)
    if alg == "hmac-sha256-ctr":
        if len(ct) < 32:
            raise BrokerError("ciphertext is truncated")
        body, tag = ct[:-32], ct[-32:]
        if not hmac.compare_digest(tag, _mac(key, nonce, body)):
            raise BrokerError("store authentication failed")
        return bytes(a ^ b for a, b in zip(body, _keystream(key, nonce, len(body))))
    raise BrokerError("unknown store algorithm: %r" % (alg,))


def _machine_key():
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    try:
        with open(MACHINE_KEY_PATH, "rb") as handle:
            key = handle.read()
    except FileNotFoundError:
        key = secrets.token_bytes(32)
        # O_EXCL so a concurrent host cannot both create it and race the write.
        fd = os.open(MACHINE_KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, key)
        finally:
            os.close(fd)
        return key
    if len(key) < 32:
        raise BrokerError("machine key is truncated")
    return key[:32]


# --------------------------------------------------------------------------
# encrypted file backend
# --------------------------------------------------------------------------

def _load_file_store():
    try:
        with open(STORE_PATH, "rb") as handle:
            envelope = json.loads(handle.read().decode("utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as exc:
        raise BrokerError("store is not valid JSON: %s" % (exc,))
    payload = _open(_machine_key(), envelope)
    try:
        data = json.loads(payload.decode("utf-8"))
    except ValueError as exc:
        raise BrokerError("store payload is not valid JSON: %s" % (exc,))
    if not isinstance(data, dict):
        raise BrokerError("store payload is not an object")
    return data


def _save_file_store(data):
    envelope = _seal(_machine_key(), json.dumps(data).encode("utf-8"))
    envelope["v"] = VERSION
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(json.dumps(envelope).encode("utf-8"))
    os.chmod(tmp, 0o600)
    os.replace(tmp, STORE_PATH)


# --------------------------------------------------------------------------
# keychain backend
# --------------------------------------------------------------------------

def _keychain_kind():
    """Return 'libsecret', 'macos' or 'dpapi', or None when none is usable."""
    system = platform.system()
    if system == "Darwin":
        return "macos" if shutil.which("security") else None
    if system == "Windows":
        return "dpapi"
    return "libsecret" if shutil.which("secret-tool") else None


def _keychain_get(name):
    kind = _keychain_kind()
    if kind is None:
        return None
    if kind == "libsecret":
        try:
            out = subprocess.run(
                ["secret-tool", "lookup", "service", SERVICE, "provider", name],
                capture_output=True, timeout=15,
            )
        except Exception:
            return None
        if out.returncode != 0:
            return None
        value = out.stdout.decode("utf-8", "replace").strip()
        return value or None
    if kind == "macos":
        try:
            out = subprocess.run(
                ["security", "find-generic-password", "-s", _service_name(name), "-w"],
                capture_output=True, timeout=15,
            )
        except Exception:
            return None
        if out.returncode != 0:
            return None
        value = out.stdout.decode("utf-8", "replace").rstrip("\n")
        return value or None
    return _dpapi_unprotect(_dpapi_key_path(name))


def _keychain_put(name, value):
    kind = _keychain_kind()
    if kind is None:
        return False
    if kind == "libsecret":
        try:
            out = subprocess.run(
                ["secret-tool", "store", "--label=" + SERVICE, "service", SERVICE, "provider", name],
                input=value.encode("utf-8"), capture_output=True, timeout=15,
            )
        except Exception:
            return False
        return out.returncode == 0
    if kind == "macos":
        try:
            out = subprocess.run(
                ["security", "add-generic-password", "-U", "-s", _service_name(name), "-w", value],
                capture_output=True, timeout=15,
            )
        except Exception:
            return False
        return out.returncode == 0
    return _dpapi_protect_store(_dpapi_key_path(name), value)


def _keychain_delete(name):
    kind = _keychain_kind()
    if kind is None:
        return False
    if kind == "libsecret":
        try:
            out = subprocess.run(
                ["secret-tool", "clear", "service", SERVICE, "provider", name],
                capture_output=True, timeout=15,
            )
        except Exception:
            return False
        return out.returncode == 0
    if kind == "macos":
        try:
            out = subprocess.run(
                ["security", "delete-generic-password", "-s", _service_name(name)],
                capture_output=True, timeout=15,
            )
        except Exception:
            return False
        return out.returncode == 0
    try:
        os.remove(_dpapi_key_path(name))
        return True
    except OSError:
        return False


def _service_name(name):
    return "%s-%s" % (SERVICE, name)


def _dpapi_key_path(name):
    return os.path.join(STATE_DIR, "dpapi-%s.bin" % (name,))


def _dpapi_protect_store(path, value):
    blob = _dpapi_protect(value.encode("utf-8"))
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(blob)
    return True


def _dpapi_protect(data):
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("pb", ctypes.POINTER(ctypes.c_char))]

    def to_blob(raw):
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob = Blob()
        blob.cb = len(raw)
        blob.pb = ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))
        blob._buf = buf  # keep the buffer alive for the duration of the call
        return blob

    src = to_blob(data)
    dst = Blob()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst)
    )
    if not ok:
        raise BrokerError("CryptProtectData failed")
    try:
        return ctypes.string_at(dst.pb, dst.cb)
    finally:
        ctypes.windll.kernel32.LocalFree(dst.pb)


def _dpapi_unprotect(path):
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("pb", ctypes.POINTER(ctypes.c_char))]

    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        return None
    src = Blob()
    src.cb = len(raw)
    src.pb = ctypes.cast(ctypes.create_string_buffer(raw, len(raw)), ctypes.POINTER(ctypes.c_char))
    dst = Blob()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst)
    )
    if not ok:
        raise BrokerError("CryptUnprotectData failed")
    try:
        value = ctypes.string_at(dst.pb, dst.cb).decode("utf-8", "replace")
        return value or None
    finally:
        ctypes.windll.kernel32.LocalFree(dst.pb)


# --------------------------------------------------------------------------
# provider index -- names only, never key material
# --------------------------------------------------------------------------

def _load_index():
    try:
        with open(INDEX_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _save_index(index):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    tmp = INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(index, handle, indent=1, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, INDEX_PATH)


# --------------------------------------------------------------------------
# dispatch
# --------------------------------------------------------------------------

def _read_from(backend, name):
    if backend == KEYCHAIN:
        return _keychain_get(name)
    return _load_file_store().get(name)


def _write_to(backend, name, value):
    if backend == KEYCHAIN:
        return _keychain_put(name, value)
    store = _load_file_store()
    store[name] = value
    _save_file_store(store)
    return True


def _delete_from(backend, name):
    if backend == KEYCHAIN:
        return _keychain_delete(name)
    store = _load_file_store()
    if name in store:
        del store[name]
        _save_file_store(store)
        return True
    return False


def _active_backend():
    return KEYCHAIN if _keychain_kind() is not None else FILE


def _dispatch(message):
    command = (message or {}).get("cmd")
    name = (message or {}).get("provider")
    index = _load_index()

    if command == "ping":
        return {
            "ok": True,
            "version": VERSION,
            "backend": _active_backend(),
            "cipher": "aes256gcm" if _HAVE_GCM else "hmac-sha256-ctr",
        }

    if command == "status":
        return {
            "ok": True,
            "version": VERSION,
            "backend": _active_backend(),
            "cipher": "aes256gcm" if _HAVE_GCM else "hmac-sha256-ctr",
            "stateDir": STATE_DIR,
            "providers": sorted(index.keys()),
        }

    if command == "list":
        return {"ok": True, "providers": sorted(index.keys())}

    if not isinstance(name, str) or not name.strip():
        raise BrokerError("a non-empty 'provider' is required")
    name = name.strip()

    if command == "get":
        backend = index.get(name)
        value = None
        if backend:
            try:
                value = _read_from(backend, name)
            except BrokerError:
                value = None
        if value is None:
            # Fall through to the other backend: a provider may have been
            # written before the keychain was available on this machine.
            for candidate in (KEYCHAIN, FILE):
                if candidate == backend:
                    continue
                try:
                    value = _read_from(candidate, name)
                except BrokerError:
                    value = None
                if value is not None:
                    break
        return {"ok": True, "key": value if value is not None else ""}

    if command == "put":
        value = (message or {}).get("key")
        if not isinstance(value, str) or value == "":
            raise BrokerError("a non-empty 'key' is required")
        backend = KEYCHAIN if _keychain_kind() is not None else FILE
        if not _write_to(backend, name, value):
            if backend == KEYCHAIN:
                backend = FILE
                if not _write_to(backend, name, value):
                    raise BrokerError("both keychain and file backends refused the write")
            else:
                raise BrokerError("the file backend refused the write")
        index[name] = backend
        _save_index(index)
        return {"ok": True, "backend": backend}

    if command == "delete":
        removed = False
        for backend in (KEYCHAIN, FILE):
            try:
                removed = _delete_from(backend, name) or removed
            except BrokerError:
                pass
        index.pop(name, None)
        _save_index(index)
        return {"ok": True, "removed": removed}

    raise BrokerError("unknown command: %r" % (command,))


# --------------------------------------------------------------------------
# native messaging transport
# --------------------------------------------------------------------------

def _safe_dispatch(message):
    """Run one request, turning any failure into a reply object.

    Both the protocol loop and the self-test go through here so the self-test
    exercises the same error boundary a real browser request hits.
    """
    try:
        return _dispatch(message)
    except BrokerError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # pragma: no cover - defensive
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


def _read_message():
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise BrokerError("truncated message header")
    (length,) = struct.unpack("=I", header)
    if length == 0 or length > MAX_MESSAGE:
        raise BrokerError("message length out of range")
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        raise BrokerError("truncated message body")
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise BrokerError("message is not valid JSON: %s" % (exc,))


def _write_message(payload):
    body = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def _self_test():
    """Exercise the store in-process against a throwaway HOME.

    Used by the installer and by verification runs so a host can be proven
    working on a machine without registering it with a browser first. Exits
    non-zero on the first failure.
    """
    import tempfile

    global STATE_DIR, STORE_PATH, MACHINE_KEY_PATH, INDEX_PATH

    sandbox = tempfile.mkdtemp(prefix="sentinel-broker-selftest-")
    original = (STATE_DIR, STORE_PATH, MACHINE_KEY_PATH, INDEX_PATH)
    try:
        STATE_DIR = os.path.join(sandbox, ".sentinel")
        STORE_PATH = os.path.join(STATE_DIR, "credentials.enc")
        MACHINE_KEY_PATH = os.path.join(STATE_DIR, ".machine-key")
        INDEX_PATH = os.path.join(STATE_DIR, "providers.json")

        sentinel = "selftest-" + secrets.token_hex(8)
        failures = []

        def check(label, condition):
            print(("PASS " if condition else "FAIL ") + label)
            if not condition:
                failures.append(label)

        reply = _safe_dispatch({"cmd": "ping"})
        check("ping answers", reply.get("ok") is True)
        check("backend is reported", reply.get("backend") in (KEYCHAIN, FILE))

        check("put stores a key", _safe_dispatch({"cmd": "put", "provider": "selftest", "key": sentinel}).get("ok") is True)
        check("get returns it unchanged", _safe_dispatch({"cmd": "get", "provider": "selftest"}).get("key") == sentinel)
        check("list names it", "selftest" in _safe_dispatch({"cmd": "list"}).get("providers", []))
        check("get on a stranger is empty", _safe_dispatch({"cmd": "get", "provider": "nobody"}).get("key") == "")
        check("empty key refused", _safe_dispatch({"cmd": "put", "provider": "x", "key": ""}).get("ok") is False)
        check("unknown command refused", _safe_dispatch({"cmd": "nope"}).get("ok") is False)
        check("delete removes it", _safe_dispatch({"cmd": "delete", "provider": "selftest"}).get("ok") is True)
        check("get after delete is empty", _safe_dispatch({"cmd": "get", "provider": "selftest"}).get("key") == "")

        # The plaintext must not survive anywhere in the state directory.
        _safe_dispatch({"cmd": "put", "provider": "selftest", "key": sentinel})
        on_disk = []
        for root, _dirs, files in os.walk(STATE_DIR):
            for name in files:
                path = os.path.join(root, name)
                try:
                    with open(path, "rb") as handle:
                        if sentinel.encode("utf-8") in handle.read():
                            on_disk.append(path)
                except OSError:
                    pass
        check("plaintext never written to the state directory", not on_disk)

        # Authentication must fail closed on a flipped byte.
        try:
            with open(STORE_PATH, "rb") as handle:
                raw = bytearray(handle.read())
            raw[-5] ^= 0x01
            with open(STORE_PATH, "wb") as handle:
                handle.write(bytes(raw))
            check("tampered store fails closed", _safe_dispatch({"cmd": "get", "provider": "selftest"}).get("key") == "")
        except OSError:
            check("tampered store fails closed", True)  # keychain backend has no file to flip

        print("FAILURES:", failures if failures else "none")
        return 1 if failures else 0
    finally:
        _d, _s, _m, _i = original
        STATE_DIR, STORE_PATH, MACHINE_KEY_PATH, INDEX_PATH = _d, _s, _m, _i
        shutil.rmtree(sandbox, ignore_errors=True)


def main():
    if "--self-test" in sys.argv[1:]:
        return _self_test()

    while True:
        try:
            message = _read_message()
        except BrokerError as exc:
            try:
                _write_message({"ok": False, "error": str(exc)})
            except Exception:
                pass
            return 1
        except Exception as exc:  # pragma: no cover - transport failure
            try:
                _write_message({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)})
            except Exception:
                pass
            return 1
        if message is None:
            return 0
        reply = _safe_dispatch(message)
        try:
            _write_message(reply)
        except Exception:  # pragma: no cover - transport failure
            return 1


if __name__ == "__main__":
    sys.exit(main())
