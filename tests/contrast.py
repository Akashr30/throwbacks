#!/usr/bin/env python3
"""WCAG contrast audit of Liquid Glass (glass.css): every text color on
every surface it's used on, in light and dark mode, under every sky. Text
needs 4.5:1 (WCAG AA); icons, marks and data shapes need 3:1.

Liquid Glass surfaces are translucent, so each is composited the way it
is drawn (a pane over the sky, a card over the pane, …) over every color
its sky is made of, and the worst case has to pass.

    python3 tests/contrast.py
"""

import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent.parent
GLASS = (HERE / "glass.css").read_text()


def block(selector, css=None):
    m = re.search(r"(?:^|\n)" + re.escape(selector) + r"\s*\{(.*?)\n\}", css or GLASS, re.S)
    if not m:
        sys.exit(f"selector {selector!r} not found")
    return m.group(1)


def tokens(text):
    return {name: " ".join(val.split()) for name, val in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", text)}


def half(value, mode):
    """One side of light-dark(a, b); other values pass through."""
    m = re.match(r"light-dark\((.*)\)$", value)
    if not m:
        return value
    inner, depth = m.group(1), 0
    for i, ch in enumerate(inner):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            return (inner[:i] if mode == "light" else inner[i + 1:]).strip()
    raise ValueError(value)


def resolve(table, name, mode):
    value = half(table[name], mode)
    m = re.match(r"var\((--[\w-]+)\)$", value)
    if m:
        return resolve(table, m.group(1), mode)
    # color-mix(in oklab, <color> N%, transparent) is that color at N% alpha
    m = re.match(r"color-mix\(in oklab, (.+) ([\d.]+)%, transparent\)$", value)
    if m:
        inner = m.group(1)
        v = re.match(r"var\((--[\w-]+)\)$", inner)
        r, g, b, a = rgba(resolve(table, v.group(1), mode) if v else inner)
        return f"rgba({r}, {g}, {b}, {a * float(m.group(2)) / 100})"
    return value


def rgba(value):
    value = value.strip()
    if value.startswith("#"):
        h = value[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (1.0,)
    parts = [x.strip() for x in re.match(r"rgba?\(([^)]*)\)", value).group(1).split(",")]
    return (float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]) if len(parts) > 3 else 1.0)


def over(fg, bg):
    a = fg[3]
    return tuple(fg[i] * a + bg[i] * (1 - a) for i in range(3)) + (1.0,)


def luminance(c):
    def channel(x):
        x /= 255
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
    return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])


def ratio(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


# ---- Liquid Glass ----------------------------------------------------------

SKIES = ("dawn", "day", "dusk", "night", "mono")

# Each surface as it is drawn: (layer token, what it sits on). "sky" is a
# color of the wallpaper; every surface is checked over every sky color.
SURFACES = {
    "pane": ("--lg-pane", "sky"),          # the rail, cards on the front page
    "pane2": ("--lg-pane-2", "sky"),       # the main pane and the conversation
    "raise": ("--lg-raise", "pane"),       # controls, tiles
    "raise2": ("--lg-raise-2", "pane"),    # hovered controls
    "raise-chat": ("--lg-raise", "pane2"), # cards, chips, the week's rows
    "raise2-main": ("--lg-raise-2", "pane2"),  # the day's and the week's summary
    "sel-main": ("--lg-raise-sel", "pane2"),  # what's chosen: a chip, a day, a card
    "float": ("--lg-float", "pane2"),      # menus, dialogs, toasts
    "sunk": ("--lg-sunk", "pane"),         # fields, tracks
    "sunk-main": ("--lg-sunk", "raise-chat"),  # the week strip, the activity lanes
    "hover-card": ("--lg-raise-row", "raise-chat"),  # a hovered row in a card (the folder tree)
    "sel-card": ("--lg-raise-sel", "raise-chat"),  # the open session's row in a card
    "hover2-card": ("--lg-raise-2", "hover-card"),  # a hovered button in a hovered row (Open as one chat, a folder's commits)
    "hover-pane": ("--lg-raise-row", "pane2"),  # a hovered fold on the page (Still going's archived)
    "act-card": ("--lg-raise-2", "raise2-main"),  # a hovered button on a hovered card (pin, archive, resume) or row (Restore)
    "bubble": ("--lg-bubble", "pane2"),    # (dialogs' summaries)
    "soft": ("--lg-accent-soft", "pane2"), # notes, the open day pill
    "soft-card": ("--lg-accent-soft", "raise2-main"),  # "New since…", a chosen app
    "soft-sunk": ("--lg-accent-soft", "sunk-main"),  # "Today" on a day's band in the sheet
    "chip": ("--lg-accent-soft", "pane2"),  # paths and links in replies
    "heat1": ("--lg-heat-1", "raise"), "heat2": ("--lg-heat-2", "raise"), "heat3": ("--lg-heat-3", "raise"),
    "danger": ("--lg-danger-soft", "float"),
    "code": ("--lg-code", "bubble"),
    "accent": ("--lg-accent", None),       # your messages, primary buttons, busiest day
}

# (text token, surface, minimum ratio)
GLASS_PAIRS = [
    *[(ink, srf, 4.5) for ink in ("--lg-ink", "--lg-ink-2", "--lg-ink-3")
      for srf in ("pane", "pane2", "raise", "raise2", "raise-chat", "raise2-main", "sel-main", "float", "sunk", "sunk-main", "bubble")],
    *[("--lg-accent-ink", srf, 4.5) for srf in ("pane", "pane2", "raise", "raise-chat", "sel-main", "float", "bubble", "soft", "soft-card", "chip")],
    *[("--lg-warn", srf, 4.5) for srf in ("raise-chat", "sel-main", "float", "pane2")],
    *[("--lg-danger", srf, 4.5) for srf in ("raise-chat", "sel-main")],
    ("--lg-warn-fill", "raise-chat", 3.0), ("--lg-warn-fill", "sunk-main", 3.0),
    *[(f"--series-{i}", "sunk-main", 3.0) for i in range(1, 7)],
    ("--lg-ai", "raise2-main", 3.0),
    ("--lg-heat-ink", "heat1", 4.5), ("--lg-heat-ink", "heat2", 4.5), ("--lg-heat-3-ink", "heat3", 4.5),
    ("--lg-on-accent", "accent", 4.5), ("--lg-on-accent-2", "accent", 4.5),
    ("--lg-danger", "danger", 4.5), ("--lg-danger", "float", 4.5),
    ("--lg-code-ink", "code", 4.5), ("--lg-ai", "raise", 3.0),
    *[(f"--series-{i}", srf, 3.0) for i in range(1, 7) for srf in ("pane", "raise")],
    ("--lg-data", "raise-chat", 3.0), ("--lg-accent-ink", "pane", 3.0),
    # Rows in a card: hovered and open ones lift muted text to ink-2 (glass.css .tree);
    # a hovered folder row holds the "Open as one chat" link.
    *[(ink, srf, 4.5) for ink in ("--lg-ink", "--lg-ink-2") for srf in ("hover-card", "sel-card")],
    ("--lg-accent-ink", "hover-card", 4.5),
    ("--lg-ink", "hover2-card", 4.5),
    # A commit's marker in its chat: its message and ID on the soft accent.
    ("--lg-ink", "soft", 4.5), ("--lg-ink-2", "soft", 4.5),
    # The sheet's bands (a day, a folder): Open day, and Today.
    ("--lg-accent-ink", "sunk-main", 4.5), ("--lg-accent-ink", "soft-sunk", 4.5),
    # Still going: a lit pin on a hovered card, Restore on a hovered row; their hover; the archived fold.
    ("--lg-accent-ink", "raise2-main", 4.5), ("--lg-ink", "act-card", 4.5),
    # A recap's project names on its card when you point at it (click to edit), and its text while you edit it.
    ("--lg-ink-2", "act-card", 4.5), ("--lg-ink", "sel-main", 4.5),
    *[(ink, "hover-pane", 4.5) for ink in ("--lg-ink", "--lg-ink-2", "--lg-accent-ink")], ("--lg-ink-3", "hover-pane", 3.0),
]


def glass_table(sky):
    table = tokens(block(":root", GLASS))
    table.update(tokens(block("[data-sky]", GLASS)))
    table.update(tokens(block(f'[data-sky="{sky}"]', GLASS)))
    # the busiest-but-one calendar step: Mono's dark mode writes it in the accent's own ink
    table["--lg-heat-3-ink"] = "light-dark(var(--lg-ink), var(--lg-on-accent))" if sky == "mono" else "var(--lg-heat-ink)"
    return table


def surface(table, name, mode, sky_color, cache):
    if name == "sky":
        return sky_color
    if name not in cache:
        layer, under = SURFACES[name]
        color = rgba(resolve(table, layer, mode))
        cache[name] = color if under is None else over(color, surface(table, under, mode, sky_color, cache))
    return cache[name]


def audit_glass():
    failures = 0
    for sky in SKIES:
        table = glass_table(sky)
        for mode in ("light", "dark"):
            bad = []
            for sky_token in ("--sky-base", "--sky-1", "--sky-2", "--sky-3", "--sky-4"):
                sky_color = rgba(resolve(table, sky_token, mode))
                cache = {}
                for fg, srf, need in GLASS_PAIRS:
                    back = surface(table, srf, mode, sky_color, cache)
                    r = ratio(over(rgba(resolve(table, fg, mode)), back), back)
                    if r < need:
                        bad.append(f"  FAIL {fg} on {srf} over {sky_token}: {r:.2f}:1 (needs {need}:1)")
            failures += len(bad)
            print(f"glass/{sky}/{mode}: {'all ' + str(len(GLASS_PAIRS)) + ' pairs pass' if not bad else ''}")
            for line in bad:
                print(line)
    return failures


def main():
    sys.exit(1 if audit_glass() else 0)


if __name__ == "__main__":
    main()
