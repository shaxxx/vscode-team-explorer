"""Catch escape corruption in planning documents before an agent acts on them.

Two channels in this project's tooling silently damage text on its way to disk,
and both have produced real defects in `docs/superpowers/plans/`:

  1. The Bash tool eats single backslashes in heredocs. A code fence written
     that way arrives with `path.replace(/\\/g, '/')` reduced to `/\/g`, which
     does not parse, and `'C:\\work\\Proj'` reduced to `'C:\work\Proj'`, which
     DOES parse and silently evaluates to `C:workProj`.

  2. The Write/Edit parameter layer decodes literal `\\uXXXX` and `\\b` escape
     text into real control characters. Amendment 7 of plan 2 acquired a NUL
     byte while describing this very hazard, and Task 9 acquired a backspace
     where a backslash-anchored pattern was meant.

Neither failure is visible when reading the rendered Markdown, and both survive
review by eye. Hence a script.

Usage:  python scripts/check-doc-escapes.py <file>...
Exit 1 if anything is found.
"""

import io
import re
import sys

BS = chr(92)
DOUBLE = BS + BS

# Shapes that do not even parse as JavaScript/TypeScript.
FATAL = [
    ("'" + BS + "'", 'unterminated string literal'),
    ('/' + BS + '/g', 'regex terminates early'),
    ('/' + BS + '/;', 'regex terminates early'),
    ('/' + BS + '/)', 'regex terminates early'),
    ('/' + BS + '/,', 'regex terminates early'),
]

# A quoted Windows path with SINGLE backslashes (`'C:\temp\new'`, `'\server\share'`).
# Checked after doubled backslashes are removed, so a correctly doubled path
# never matches. `\t` and `\n` are ordinary escapes, which is why the LONE check
# below cannot see these.
QUOTE = '[' + "'" + '"' + '`]'
BSRE = re.escape(BS)
WINDOWS_PATH = re.compile(
    QUOTE + '[^' + "'" + '"`]*(?:[A-Za-z]:' + BSRE + '|' + BSRE + '[A-Za-z]{2,}' + BSRE + ')'
)

# Escapes that are ordinary inside a regex or string and need no doubling.
ORDINARY = 'rnstwdSWDbu.$^|(){}[]+*?/-'


def check(path):
    raw = io.open(path, 'rb').read()
    problems = []

    # 1. Control characters: almost certainly a decoded escape sequence.
    #    TAB and a CR not followed by LF count too: they are what a decoded
    #    `\t` or `\r` looks like, and no document here uses either on purpose.
    LF, CR = 10, 13
    for i, b in enumerate(raw):
        lone_cr = b == CR and (i + 1 >= len(raw) or raw[i + 1] != LF)
        if b < LF or (11 <= b <= 12) or (14 <= b <= 31) or lone_cr:
            line = raw[:i].count(bytes([LF])) + 1
            problems.append((line, 'CONTROL', 'byte 0x%02x -- a decoded escape?' % b))

    # 2. Broken backslashes, inside fenced code blocks only. Prose may say
    #    `C:\work` freely; a string literal may not.
    # Only code fences, and only ones tagged as a language where a backslash is
    # a string or regex escape. A `bash` or untagged fence may legitimately hold
    # a Windows path or a directory listing.
    CODE_LANGS = ('ts', 'tsx', 'js', 'jsx', 'javascript', 'typescript')
    infence = False
    lang = ''
    for n, line in enumerate(raw.decode('utf-8', 'replace').split('\n'), 1):
        if line.lstrip().startswith('```'):
            # First word only: `typescript {1}` is still TypeScript.
            words = line.strip()[3:].strip().lower().split()
            lang = (words[0] if words else '') if not infence else ''
            infence = not infence
            continue
        if not infence or lang not in CODE_LANGS or BS not in line:
            continue

        for shape, why in FATAL:
            if shape in line:
                problems.append((n, 'FATAL', why + ': ' + line.strip()[:70]))

        stripped = line.lstrip()
        if stripped.startswith(('*', '/*', '//', '|')):
            continue  # a comment: prose, not a literal

        undoubled = line.replace(DOUBLE, '')
        if WINDOWS_PATH.search(undoubled):
            problems.append((n, 'PATH', 'single-backslash Windows path: ' + line.strip()[:70]))

        for m in re.finditer(re.escape(BS) + '(.)', undoubled):
            if m.group(1) not in ORDINARY:
                problems.append((n, 'LONE', 'lone backslash: ' + line.strip()[:70]))
                break

    return problems


def main(argv):
    total = 0
    for path in argv[1:]:
        found = check(path)
        total += len(found)
        print('%s: %d problem(s)' % (path, len(found)))
        for line, kind, detail in found:
            print('  line %d [%s] %s' % (line, kind, detail))
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
