#!/usr/bin/env python3
"""Register the Sentinel credential broker as a native messaging host.

WHY THIS COPIES THE HOST. The manifest Chrome/Firefox reads carries an ABSOLUTE
path to the host executable. Pointing that at a git checkout means a `git pull`
that moves or deletes the tree silently breaks the broker. So the host is
installed to a stable location (~/.sentinel/bin/) and the manifest points there.

USAGE
    python3 install_host.py                      # install for every detected browser
    python3 install_host.py --browser firefox
    python3 install_host.py --browser chrome --id abcdefghijklmnopabcdefghijklmnop
    python3 install_host.py --dry-run
    python3 install_host.py --uninstall

The extension (Chrome) or addon (Firefox) id is read from manifest.json by
default, so it never has to be typed. Pass --id to override.

Registration locations
    Linux   Chrome   ~/.config/<browser>/NativeMessagingHosts/
            Firefox  ~/.mozilla/native-messaging-hosts/
    macOS   Chrome   ~/Library/Application Support/<browser>/NativeMessagingHosts/
            Firefox  ~/Library/Application Support/Mozilla/NativeMessagingHosts/
    Windows both     HKCU\\Software\\<vendor>\\NativeMessagingHosts\\com.sentinel.broker
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys

HOST_NAME = "com.sentinel.broker"
HERE = os.path.dirname(os.path.abspath(__file__))
HOST_SOURCE = os.path.join(HERE, "sentinel_broker.py")
INSTALL_DIR = os.path.join(os.path.expanduser("~"), ".sentinel", "bin")
HOST_INSTALL_PATH = os.path.join(INSTALL_DIR, "sentinel_broker.py")
# Kept in step with sentinel_broker.py: uninstall reports this file so the user
# can decide about their own keys, but never deletes it.
STATE_DIR = os.path.join(os.path.expanduser("~"), ".sentinel")
STORE_PATH = os.path.join(STATE_DIR, "credentials.enc")
MANIFEST_NAME = HOST_NAME + ".json"

CHROME_DIRS = [
    "Google/Chrome",
    "Google/Chrome Beta",
    "Google/Chrome Dev",
    "chromium",
    "BraveSoftware/Brave-Browser",
    "microsoft-edge",
    "vivaldi",
]
FIREFOX_DIRS = ["Mozilla"]


def fail(message):
    print("ERROR: " + message)
    return 1


def addon_id_from_manifest(path):
    """Read the extension/addon id out of a manifest.json, or None."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except OSError as exc:
        return None, "cannot read %s: %s" % (path, exc)
    except ValueError as exc:
        return None, "%s is not valid JSON: %s" % (path, exc)

    gecko = manifest.get("browser_specific_settings") or {}
    for candidate in (gecko.get("gecko", {}) or {}).get("id"), manifest.get("key"):
        if candidate:
            return candidate, None
    return None, "%s declares no gecko.id and no key" % (path,)


def unpacked_extension_id(path):
    """Derive the id Chrome assigns to an unpacked extension from its path.

    Chrome hashes the absolute path of an unpacked extension and maps the first
    32 hex digits onto a-p. A manifest without a "key" gets this id, and it is
    what has to appear in allowed_origins -- so a development install can be
    registered without publishing anything.
    """
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()
    alphabet = "abcdefghijklmnopqrstuvwxyz"
    return "".join(alphabet[int(char, 16)] for char in digest[:32])


def install_host_script(python_path):
    """Copy the host to its stable location. Returns (path, error)."""
    os.makedirs(INSTALL_DIR, mode=0o700, exist_ok=True)
    target = HOST_INSTALL_PATH
    try:
        shutil.copy2(HOST_SOURCE, target)
        os.chmod(target, 0o755)
    except OSError as exc:
        return None, "cannot install the host to %s: %s" % (target, exc)
    return target, None


def run_self_test(host_path, python_path):
    """Prove the installed host works before registering anything."""
    try:
        out = subprocess.run(
            [python_path, host_path, "--self-test"],
            capture_output=True, timeout=120,
        )
    except Exception as exc:
        return False, "self-test could not run: %s" % (exc,)
    if out.returncode != 0:
        detail = out.stdout.decode("utf-8", "replace").strip()
        return False, "self-test failed:\n" + detail
    return True, out.stdout.decode("utf-8", "replace").strip()


def chrome_dirs(home):
    system = platform.system()
    if system == "Darwin":
        base = os.path.join(home, "Library", "Application Support")
        return [(name, os.path.join(base, name, "NativeMessagingHosts")) for name in CHROME_DIRS]
    if system == "Windows":
        return [("Google/Chrome", os.path.join("SOFTWARE", "Google", "Chrome"))]
    base = os.path.join(home, ".config")
    return [(name, os.path.join(base, name, "NativeMessagingHosts")) for name in CHROME_DIRS]


def firefox_dirs(home):
    system = platform.system()
    if system == "Darwin":
        return [("Mozilla", os.path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts"))]
    if system == "Windows":
        return [("Mozilla", os.path.join("SOFTWARE", "Mozilla"))]
    return [("Mozilla", os.path.join(home, ".mozilla", "native-messaging-hosts"))]


def register_windows(registry_path, manifest_path):
    try:
        import winreg
    except ImportError:
        return "winreg is unavailable on this interpreter"
    try:
        key = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, registry_path, 0, winreg.KEY_WRITE)
        with key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)
    except OSError as exc:
        return "registry write failed: %s" % (exc,)
    return None


def unregister_windows(registry_path):
    try:
        import winreg
    except ImportError:
        return "winreg is unavailable on this interpreter"
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, registry_path)
    except OSError as exc:
        return "registry delete failed: %s" % (exc,)
    return None


def _prune_empty_dir(path):
    """Remove a directory the installer created, but only if it is now empty.

    A browser profile that holds anything else alongside our manifest keeps its
    directory, so this can never take a user's data with it.
    """
    try:
        os.rmdir(path)
    except OSError:
        pass


def main():
    parser = argparse.ArgumentParser(description="Register the Sentinel credential broker.")
    parser.add_argument("--browser", choices=["chrome", "firefox", "all"], default="all")
    parser.add_argument("--id", dest="override_id", help="extension/addon id (default: read manifest.json)")
    parser.add_argument("--manifest", default=os.path.join(HERE, "..", "manifest.json"))
    parser.add_argument("--path", dest="unpack_path",
                        help="unpacked extension directory; derives the Chrome id from its path")
    parser.add_argument("--python", default=sys.executable, help="interpreter to run the host")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()

    home = os.path.expanduser("~")
    system = platform.system()
    python_path = os.path.abspath(args.python)
    browsers = ["chrome", "firefox"] if args.browser == "all" else [args.browser]

    # The id is only needed to WRITE a manifest. Uninstall removes manifests by
    # filename, so it has to work with a bare `--uninstall` -- documented usage
    # that used to fail for want of an id it never needed.
    extension_id = None
    id_error = None
    if args.override_id:
        extension_id = args.override_id
    elif args.unpack_path:
        if not os.path.isdir(args.unpack_path):
            return fail("--path %s is not a directory" % args.unpack_path)
        extension_id = unpacked_extension_id(args.unpack_path)
        print("derived unpacked extension id from %s" % os.path.abspath(args.unpack_path))
    elif not args.uninstall:
        extension_id, id_error = addon_id_from_manifest(args.manifest)
    if not extension_id and not args.uninstall:
        return fail(
            id_error + "\n"
            "Pass --id <id> explicitly, or --path <dir> to derive the id of an unpacked install."
        )

    if args.dry_run:
        print("dry run -- nothing was written")
        print("  system      : %s" % system)
        print("  host script : %s" % HOST_SOURCE)
        print("  install dir : %s" % INSTALL_DIR)
        print("  manifest id : %s" % extension_id)
        print("  browsers    : %s" % ", ".join(browsers))
        return 0

    if args.uninstall:
        errors = []
        for browser in browsers:
            entries = chrome_dirs(home) if browser == "chrome" else firefox_dirs(home)
            for label, path in entries:
                if path.startswith("SOFTWARE"):
                    problem = unregister_windows(os.path.join(path, "NativeMessagingHosts", HOST_NAME))
                    if problem:
                        errors.append("%s: %s" % (label, problem))
                    else:
                        print("unregistered %s (%s)" % (label, path))
                    continue
                target = os.path.join(path, MANIFEST_NAME)
                try:
                    os.remove(target)
                    print("removed %s" % target)
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    errors.append("%s: %s" % (target, exc))
                    continue
                # Drop the manifest's own directory when it is now empty, so an
                # uninstall does not leave a trail of empty browser dirs behind.
                _prune_empty_dir(path)
        # The host script is the installer's own artifact and is shared by every
        # registered manifest, so it goes once the last manifest is gone.
        try:
            os.remove(HOST_INSTALL_PATH)
            print("removed %s" % HOST_INSTALL_PATH)
        except FileNotFoundError:
            pass
        except OSError as exc:
            errors.append("%s: %s" % (HOST_INSTALL_PATH, exc))
        # The encrypted store is NOT touched. It holds the user's keys, not the
        # installer's state, and deleting secrets the user never asked gone is
        # not this tool's call. Say where it is so the choice stays theirs.
        if os.path.exists(STORE_PATH):
            print(
                "kept %s (your encrypted keys). "
                "Delete it by hand if you want them gone." % STORE_PATH
            )
        # Only succeeds if the directory is empty, so a ~/.sentinel that holds
        # anything else is left exactly as it was.
        for path in (INSTALL_DIR, os.path.dirname(INSTALL_DIR)):
            try:
                os.rmdir(path)
            except OSError:
                pass
        if errors:
            for line in errors:
                print("ERROR: " + line)
            return 1
        print("uninstall complete")
        return 0

    host_path, problem = install_host_script(python_path)
    if problem:
        return fail(problem)
    print("installed host -> %s" % host_path)

    ok, detail = run_self_test(host_path, python_path)
    if not ok:
        return fail(detail)
    print("host self-test passed")
    for line in detail.splitlines():
        if line.startswith("PASS") or line.startswith("FAIL"):
            print("  " + line)

    # On Windows the host must be launched through a shim, because Chrome runs
    # the manifest path directly and will not resolve a .py file association.
    if system == "Windows":
        shim = os.path.join(INSTALL_DIR, "sentinel_broker.cmd")
        with open(shim, "w", encoding="utf-8") as handle:
            handle.write('@echo off\r\n"%s" "%s" %%*\r\n' % (python_path, host_path))
        os.chmod(shim, 0o755)
        host_path = shim
        print("installed windows shim -> %s" % shim)

    manifest_path = os.path.join(INSTALL_DIR, MANIFEST_NAME)
    errors = []

    for browser in browsers:
        template = os.path.join(
            HERE,
            "com.sentinel.broker.firefox.template.json" if browser == "firefox"
            else "com.sentinel.broker.template.json",
        )
        try:
            with open(template, "r", encoding="utf-8") as handle:
                body = handle.read()
        except OSError as exc:
            return fail("cannot read %s: %s" % (template, exc))

        body = body.replace("__HOST_PATH__", host_path.replace("\\", "\\\\"))
        if browser == "firefox":
            body = body.replace("__ADDON_ID__", extension_id)
        else:
            body = body.replace("__EXTENSION_ID__", extension_id)

        entries = chrome_dirs(home) if browser == "chrome" else firefox_dirs(home)
        for label, path in entries:
            if path.startswith("SOFTWARE"):
                problem = register_windows(os.path.join(path, "NativeMessagingHosts", HOST_NAME), manifest_path)
                if problem:
                    errors.append("%s: %s" % (label, problem))
                else:
                    print("registered %s -> %s" % (label, manifest_path))
                continue
            os.makedirs(path, exist_ok=True)
            target = os.path.join(path, MANIFEST_NAME)
            try:
                with open(target, "w", encoding="utf-8") as handle:
                    handle.write(body)
                os.chmod(target, 0o644)
            except OSError as exc:
                errors.append("%s: %s" % (target, exc))
                continue
            print("registered %s -> %s" % (label, target))

    if errors:
        for line in errors:
            print("ERROR: " + line)
        return 1
    print()
    print("Done. Restart the browser, then reload the extension.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
