#!/usr/bin/env python3
"""Attach the captured artwork to the Steam shortcut for GEOMETRY II.

Steam keeps library art in userdata/<user>/config/grid/, named for the shortcut's
appid, and it keeps the small library icon in the shortcut record itself. Neither
comes from the desktop entry once the shortcut exists, which is why re-running the
installer alone does not change the artwork.

So this finds the shortcut by the launcher path, takes its appid, copies the art
into place under the names Steam looks for, and points the shortcut's icon field at
icon.png.

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
]


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
    seed = (exe[2] + name[2]).encode("utf-8", "surrogateescape")
    return (zlib.crc32(seed) | 0x80000000) & 0xFFFFFFFF


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
    args = parser.parse_args()

    launcher = os.path.abspath(args.launcher)
    art_dir = os.path.abspath(args.art)
    icon = os.path.join(art_dir, "icon.png")

    files = []
    for root in STEAM_ROOTS:
        files += glob.glob(os.path.expanduser(f"{root}/userdata/*/config/shortcuts.vdf"))
    if not files:
        print("  no Steam shortcut file found; add the game to Steam first")
        return 1

    running = steam_is_running()
    touched = 0
    for path in sorted(files):
        try:
            raw = open(path, "rb").read()
            root_items, _ = parse_map(raw, 0)
        except (ValueError, IndexError) as error:
            print(f"  skipping {path}: could not read it ({error})")
            continue

        # Only rewrite a file this code can reproduce exactly as it found it.
        faithful = write_map(root_items) == raw

        shortcuts = field(root_items, "shortcuts")
        if not shortcuts:
            continue
        changed = False
        for _, _, entry in shortcuts[2]:
            exe = field(entry, "exe")
            if not exe or launcher not in exe[2]:
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
            if not os.path.exists(backup):
                shutil.copyfile(path, backup)
                print(f"    backed up to {os.path.basename(backup)}")
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
