#!/usr/bin/env python3
"""Attach the captured artwork to the Steam shortcut for GEOMETRY II.

Steam keeps library art in userdata/<user>/config/grid/, named for the shortcut's
appid, and it keeps the small library icon in the shortcut record itself. Neither
comes from the desktop entry once the shortcut exists, which is why re-running the
installer alone does not change the artwork.

So this finds the shortcut by the launcher path, takes its appid, copies the art
into place under the names Steam looks for, and points the shortcut's icon field at
icon.png.

--wait waits for Steam to write out a shortcut it has just been given, which is the
usual way to get the shortcut and its artwork done in one go.

--add-if-missing writes the shortcut record here instead of asking Steam to. It is a
last resort: a record Steam did not create itself is not always recognised as a
shortcut, and on macOS it produced a library entry that could not be removed. Prefer
letting Steam add the game and then attaching the artwork to what Steam wrote.

shortcuts.vdf is a binary file belonging to another program, so it is only
rewritten when it can be parsed and re-serialised byte for byte first, a backup is
kept, and Steam is not running. Run with --dry-run to see what would happen.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import time
import zlib

# Steam's binary VDF: 0x00 opens a nested map, 0x01 a string, 0x02 a 32-bit int,
# 0x08 closes a map. Keys and string values are NUL-terminated.
MAP, STR, INT, END = 0x00, 0x01, 0x02, 0x08

# Which capture goes in which slot. The bare appid is the wide capsule; the rest
# are suffixed.
ART_SLOTS = [
    ("header.png", "{appid}.png"),
    ("portrait.png", "{appid}p.png"),
    ("hero.png", "{appid}_hero.png"),
    ("logo.png", "{appid}_logo.png"),
    ("icon.png", "{appid}_icon.png"),
]

STEAM_ROOTS = [
    "~/.steam/steam",
    "~/.local/share/Steam",
    "~/.var/app/com.valvesoftware.Steam/data/Steam",
    "~/Library/Application Support/Steam",  # macOS
]

# What Steam writes for a non-Steam shortcut. Absent fields are tolerated, but a
# full record avoids the client having to invent any of them.
def new_shortcut(appid_signed, name, exe, start_dir, icon):
    return [
        (INT, "appid", appid_signed),
        (STR, "AppName", name),
        (STR, "Exe", exe),
        (STR, "StartDir", start_dir),
        (STR, "icon", icon),
        (STR, "ShortcutPath", ""),
        (STR, "LaunchOptions", ""),
        (INT, "IsHidden", 0),
        (INT, "AllowDesktopConfig", 1),
        (INT, "AllowOverlay", 1),
        (INT, "OpenVR", 0),
        (INT, "Devkit", 0),
        (STR, "DevkitGameID", ""),
        (INT, "DevkitOverrideAppID", 0),
        (INT, "LastPlayTime", 0),
        (STR, "FlatpakAppID", ""),
        (MAP, "tags", []),
    ]


def derive_appid(exe, name):
    """The id Steam derives for a shortcut, as an unsigned 32-bit value."""
    return (zlib.crc32((exe + name).encode("utf-8", "surrogateescape")) | 0x80000000) & 0xFFFFFFFF


def read_cstr(data, i):
    end = data.index(b"\x00", i)
    return data[i:end].decode("utf-8", "surrogateescape"), end + 1


def parse_map(data, i):
    """Read one map, returning its entries in file order so a write can match."""
    items = []
    while True:
        kind = data[i]
        i += 1
        if kind == END:
            return items, i
        key, i = read_cstr(data, i)
        if kind == MAP:
            value, i = parse_map(data, i)
        elif kind == STR:
            value, i = read_cstr(data, i)
        elif kind == INT:
            value = int.from_bytes(data[i : i + 4], "little", signed=True)
            i += 4
        else:
            raise ValueError(f"unknown entry type {kind:#x} at byte {i - 1}")
        items.append((kind, key, value))


def write_map(items):
    out = bytearray()
    for kind, key, value in items:
        out.append(kind)
        out += key.encode("utf-8", "surrogateescape") + b"\x00"
        if kind == MAP:
            out += write_map(value)
        elif kind == STR:
            out += value.encode("utf-8", "surrogateescape") + b"\x00"
        elif kind == INT:
            out += int(value).to_bytes(4, "little", signed=True)
    out.append(END)
    return bytes(out)


def field(entry, name):
    """Look up a field case-insensitively; Steam is not consistent about case."""
    for kind, key, value in entry:
        if key.lower() == name.lower():
            return kind, key, value
    return None


def shortcut_appid(entry):
    """The number Steam names this shortcut's artwork after.

    Current clients store it outright. Older ones did not, and it was derived from
    the executable and the name, so fall back to that.
    """
    found = field(entry, "appid")
    if found and found[0] == INT:
        return found[2] & 0xFFFFFFFF
    exe = field(entry, "exe") or field(entry, "Exe")
    name = field(entry, "AppName")
    if not exe or not name:
        return None
    return derive_appid(exe[2], name[2])


def matches(entry, launcher, name):
    """Is this entry ours?

    Compared loosely on purpose. steamos-add-to-steam and this script do not
    necessarily store Exe the same way - quoting differs, and it may point at the
    desktop entry rather than the launcher - so an exact string compare will miss a
    shortcut that is already there and a second one gets created beside it.
    """
    exe = field(entry, "exe")
    appname = field(entry, "AppName")
    if exe:
        if launcher in exe[2] or os.path.basename(launcher) in exe[2]:
            return True
    if name and appname and appname[2].strip().casefold() == name.strip().casefold():
        return True
    return False


def describe(entry):
    parts = []
    for key in ("AppName", "Exe", "StartDir", "icon", "LaunchOptions", "FlatpakAppID"):
        found = field(entry, key)
        if found and found[2] != "":
            parts.append(f"      {key} = {found[2]}")
    appid_field = field(entry, "appid")
    appid = shortcut_appid(entry)
    if appid is not None:
        stored = "stored" if appid_field else "derived, this record has no appid field"
        parts.append(f"      appid = {appid} ({stored})")
        # Steam expects a shortcut id to have the top bit set. One that does not
        # can collide with a real Steam appid, which is how a shortcut ends up
        # looking like an installed game that cannot be removed.
        if not appid & 0x80000000:
            parts.append("      ^^ this appid has no high bit: Steam may read it as a real app")
    else:
        parts.append("      appid = could not be determined")
    return "\n".join(parts)


def shortcut_files():
    found = []
    for root in STEAM_ROOTS:
        found += glob.glob(os.path.expanduser(f"{root}/userdata/*/config/shortcuts.vdf"))
    return sorted(found)


def shortcut_exists(launcher, name):
    """Is the shortcut on disk yet? Used while waiting for Steam to write it out."""
    for path in shortcut_files():
        try:
            items, _ = parse_map(open(path, "rb").read(), 0)
        except (ValueError, IndexError, OSError):
            continue
        shortcuts = field(items, "shortcuts")
        if shortcuts and any(matches(e, launcher, name) for _, _, e in shortcuts[2]):
            return True
    return False


def steam_is_running():
    try:
        return subprocess.run(["pgrep", "-x", "steam"], capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launcher", required=True, help="path stored in the shortcut's Exe")
    parser.add_argument("--art", required=True, help="folder holding the captured PNGs")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--wait",
        type=float,
        default=0,
        metavar="SECONDS",
        help="wait this long for Steam to write out a shortcut it was just given",
    )
    parser.add_argument(
        "--add-if-missing",
        action="store_true",
        help="write the shortcut record directly; a last resort, see the notes above",
    )
    parser.add_argument("--name", default="GEOMETRY II", help="name for a shortcut it creates")
    parser.add_argument(
        "--list", action="store_true", help="show every shortcut Steam has, and change nothing"
    )
    parser.add_argument(
        "--remove", action="store_true", help="delete matching shortcuts and their artwork"
    )
    args = parser.parse_args()

    launcher = os.path.abspath(args.launcher)
    art_dir = os.path.abspath(args.art)
    icon = os.path.join(art_dir, "icon.png")

    # Steam holds shortcuts.vdf in memory and writes it out in its own time, so a
    # shortcut it has just accepted is not on disk immediately. Waiting is what
    # turns "add it, then run this again" into one command.
    if args.wait and not args.list and not shortcut_exists(launcher, args.name):
        deadline = time.monotonic() + args.wait
        print(f"  waiting up to {args.wait:.0f}s for Steam to write the shortcut out")
        while time.monotonic() < deadline:
            time.sleep(1)
            if shortcut_exists(launcher, args.name):
                break

    files = shortcut_files()
    running = steam_is_running()

    # A Steam account with no shortcuts at all has no shortcuts.vdf, so fall back
    # to the config folders themselves to find somewhere to create one.
    if not files and args.add_if_missing:
        configs = []
        for root in STEAM_ROOTS:
            configs += glob.glob(os.path.expanduser(f"{root}/userdata/*/config"))
        # most recently touched account, which is the one being used
        configs = [c for c in configs if os.path.basename(os.path.dirname(c)) != "0"]
        if configs:
            newest = max(configs, key=os.path.getmtime)
            files = [os.path.join(newest, "shortcuts.vdf")]
            if len(configs) > 1:
                print(f"  several Steam accounts; using the most recent, {os.path.dirname(newest)}")

    if not files:
        print("  no Steam user folder found; sign in to Steam once first")
        return 1
    touched = 0
    for path in sorted(files):
        if os.path.exists(path):
            try:
                raw = open(path, "rb").read()
                root_items, _ = parse_map(raw, 0)
            except (ValueError, IndexError) as error:
                print(f"  skipping {path}: could not read it ({error})")
                continue
        elif args.add_if_missing:
            raw, root_items = b"", [(MAP, "shortcuts", [])]
        else:
            continue

        # Only rewrite a file this code can reproduce exactly as it found it. A
        # file being created from nothing has nothing to disagree with.
        faithful = raw == b"" or write_map(root_items) == raw

        shortcuts = field(root_items, "shortcuts")
        if not shortcuts:
            continue
        changed = False

        if args.list:
            print(f"  {path}")
            print(f"    round-trips cleanly: {faithful}")
            if not shortcuts[2]:
                print("    no shortcuts")
            for _, index, entry in shortcuts[2]:
                mark = " <- matches this game" if matches(entry, launcher, args.name) else ""
                print(f"    [{index}]{mark}")
                print(describe(entry))
            touched += 1
            continue

        if args.remove:
            keep, dropped = [], []
            for item in shortcuts[2]:
                (dropped if matches(item[2], launcher, args.name) else keep).append(item)
            if not dropped:
                print(f"  nothing matching in {path}")
                continue
            if running:
                print("  Steam is running; close it before removing anything")
                return 1
            if not faithful:
                print(f"  not touching {path}: it did not round-trip cleanly")
                continue
            grid = os.path.join(os.path.dirname(path), "grid")
            for _, _, entry in dropped:
                name = field(entry, "AppName")
                appid = shortcut_appid(entry)
                print(f'  removing "{name[2] if name else "?"}" (appid {appid})')
                for _, pattern in ART_SLOTS:
                    art = os.path.join(grid, pattern.format(appid=appid))
                    if os.path.exists(art):
                        print(f"    dropping grid/{os.path.basename(art)}")
                        if not args.dry_run:
                            os.remove(art)
            # Steam indexes entries by their position, so the survivors are
            # renumbered from zero rather than left with a hole where one was.
            shortcuts[2][:] = [(MAP, str(i), item[2]) for i, item in enumerate(keep)]
            changed = not args.dry_run
            touched += 1
            if args.dry_run:
                print("    (dry run, nothing written)")

        # Create the shortcut if it is not there. Doing it here rather than handing
        # it to Steam is what lets the artwork be attached in the same pass: Steam
        # keeps shortcuts.vdf in memory and only writes it out when it exits, so a
        # shortcut it has just accepted is not yet anywhere this can find it.
        present = any(matches(entry, launcher, args.name) for _, _, entry in shortcuts[2])
        if not present and args.add_if_missing:
            if running:
                print("  Steam is running, so the shortcut cannot be written; close it first")
                return 1
            if not faithful:
                print(f"  not touching {path}: it did not round-trip cleanly")
                continue
            exe = f'"{launcher}"'
            appid = derive_appid(exe, args.name)
            entry = new_shortcut(
                appid - 2**32,
                args.name,
                exe,
                f'"{os.path.dirname(os.path.dirname(launcher))}"',
                icon if os.path.exists(icon) else "",
            )
            index = str(len(shortcuts[2]))
            if args.dry_run:
                print(f"  would create shortcut \"{args.name}\" (appid {appid}) in {path}")
            else:
                shortcuts[2].append((MAP, index, entry))
                changed = True
                print(f'  created shortcut "{args.name}", appid {appid}')
        for _, _, entry in shortcuts[2]:
            if not matches(entry, launcher, args.name):
                continue
            appid = shortcut_appid(entry)
            if appid is None:
                print("  found the shortcut but could not work out its appid")
                continue
            name = field(entry, "AppName")
            print(f"  shortcut \"{name[2] if name else '?'}\" appid {appid}")

            grid = os.path.join(os.path.dirname(path), "grid")
            for source, pattern in ART_SLOTS:
                src = os.path.join(art_dir, source)
                if not os.path.exists(src):
                    continue
                dst = os.path.join(grid, pattern.format(appid=appid))
                if args.dry_run:
                    print(f"    would copy {source} -> grid/{os.path.basename(dst)}")
                    continue
                os.makedirs(grid, exist_ok=True)
                shutil.copyfile(src, dst)
                print(f"    {source} -> grid/{os.path.basename(dst)}")
            touched += 1

            # The library icon comes from the shortcut record, not from grid/.
            current = field(entry, "icon")
            if os.path.exists(icon) and current and current[2] != icon:
                if not faithful:
                    print("    leaving the icon alone: this file did not round-trip cleanly")
                elif running:
                    print("    leaving the icon alone: close Steam and run this again")
                elif args.dry_run:
                    print("    would set the icon on the shortcut")
                else:
                    for index, (kind, key, value) in enumerate(entry):
                        if key.lower() == "icon":
                            entry[index] = (kind, key, icon)
                            changed = True
                    print("    icon set on the shortcut")

        if changed and not args.dry_run:
            backup = path + ".geometry-backup"
            if raw and not os.path.exists(backup):
                shutil.copyfile(path, backup)
                print(f"    backed up to {os.path.basename(backup)}")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(write_map(root_items))

    if not touched:
        print("  the launcher is not in any Steam shortcut yet; add the game first")
        return 1
    if running:
        print("  Steam is running: restart it to pick the artwork up")
    return 0


if __name__ == "__main__":
    sys.exit(main())
