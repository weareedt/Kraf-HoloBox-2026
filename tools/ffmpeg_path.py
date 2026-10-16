"""
Locate ffmpeg/ffprobe on whatever machine this is running on.

Every tool here used to hardcode one absolute path under C:/Users/EDT/..., which works on
exactly one PC. `tools/transcode.mjs` already resolved it properly; the Python tools did not,
so they would fail on a collaborator's machine with a confusing FileNotFoundError rather than
anything that points at the cause.

Order: the KRAF_FFMPEG override, then PATH, then a scan of the winget package folder (how it
is installed on the original machine, where it does NOT land on PATH).
"""
import os
import shutil
import subprocess


def _works(path):
    try:
        subprocess.run([path, "-version"], capture_output=True, timeout=10)
        return True
    except Exception:
        return False


def _winget(name):
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages")
    if not os.path.isdir(root):
        return None
    for pkg in os.listdir(root):
        if "ffmpeg" not in pkg.lower():
            continue
        pkgdir = os.path.join(root, pkg)
        if not os.path.isdir(pkgdir):
            continue
        for build in os.listdir(pkgdir):
            cand = os.path.join(pkgdir, build, "bin", name + ".exe")
            if os.path.isfile(cand):
                return cand
    return None


def _find(name, env):
    override = os.environ.get(env)
    if override:
        if _works(override):
            return override
        raise SystemExit(f"  {env} is set to {override!r} but it does not run.")
    onpath = shutil.which(name)
    if onpath and _works(onpath):
        return onpath
    found = _winget(name)
    if found and _works(found):
        return found
    raise SystemExit(
        f"  {name} not found.\n"
        f"    Install it:   winget install Gyan.FFmpeg\n"
        f"    Or point at it:  set {env}=C:/path/to/{name}.exe")


def ffmpeg():
    return _find("ffmpeg", "KRAF_FFMPEG")


def ffprobe():
    return _find("ffprobe", "KRAF_FFPROBE")
