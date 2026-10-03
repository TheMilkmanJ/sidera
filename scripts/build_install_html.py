"""Build docs/INSTALL.html from docs/INSTALL.md.

INSTALL.md is the source. The HTML is what the installer opens in the
default browser, because a .md file opens on Windows as raw text (or not at
all) and shows no pictures. The page has its styles inline and refers to the
screenshots by relative path (img/...), so it works offline straight from
C:\\Sidera\\docs.

Usage (from the repository root):

    python3 scripts/build_install_html.py          # rewrite docs/INSTALL.html
    python3 scripts/build_install_html.py --check  # exit 1 if it is stale

Converter: pandoc if it is installed (the committed page is built with it),
otherwise the python-markdown package (pip install markdown).
"""

import argparse
import html
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "INSTALL.md"
TARGET = ROOT / "docs" / "INSTALL.html"

STYLE = """
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 16px; line-height: 1.55;
       color: #1f2933; max-width: 860px; margin: 0 auto; padding: 24px 28px 64px; }
h1 { font-size: 28px; margin-top: 8px; }
h2 { font-size: 22px; margin-top: 36px; border-bottom: 1px solid #d9e2ec; padding-bottom: 4px; }
h3 { font-size: 18px; margin-top: 28px; }
code { font-family: Consolas, "Courier New", monospace; background: #f0f4f8; padding: 1px 4px; border-radius: 3px; }
pre { background: #f0f4f8; padding: 10px 14px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 17px; }
img { max-width: 100%; height: auto; border: 1px solid #bcccdc; border-radius: 6px; margin: 8px 0; }
blockquote { margin: 12px 0; padding: 8px 14px; background: #fffbea; border-left: 4px solid #f0b429; color: #513c06; }
blockquote p { margin: 4px 0; }
li { margin: 6px 0; }
"""


def convert(markdown_text: str) -> str:
    pandoc = shutil.which("pandoc")
    if pandoc:
        result = subprocess.run(
            [pandoc, "--from", "gfm", "--to", "html5", "--wrap=none"],
            input=markdown_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return result.stdout
    try:
        import markdown  # type: ignore
    except ImportError:
        sys.exit("Needs pandoc or the python 'markdown' package (pip install markdown).")
    return markdown.markdown(markdown_text, extensions=["fenced_code"])


def build() -> str:
    text = SOURCE.read_text(encoding="utf-8")
    title = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), "Install Sidera")
    body = convert(text)
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{html.escape(title)}</title>\n"
        "<!-- Generated from INSTALL.md by scripts/build_install_html.py; edit the .md, then rebuild. -->\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n{body}</body>\n</html>\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="only report whether INSTALL.html is current")
    args = parser.parse_args()
    if args.check and not shutil.which("pandoc"):
        # The committed page is built with pandoc; python-markdown output
        # differs in small ways, so a comparison without pandoc means nothing.
        print("pandoc is not installed; skipping the INSTALL.html freshness check")
        return 0
    page = build()
    if args.check:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != page:
            print("docs/INSTALL.html is out of date; run python3 scripts/build_install_html.py")
            return 1
        print("docs/INSTALL.html is current")
        return 0
    TARGET.write_text(page, encoding="utf-8", newline="\n")
    print(f"wrote {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
