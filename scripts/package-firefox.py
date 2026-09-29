#!/usr/bin/env python3
"""Create a Firefox add-on ZIP for submission to addons.mozilla.org."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "pokemon-browser-pet-firefox.zip"


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED) as archive:
        archive.write(ROOT / "manifest.firefox.json", "manifest.json")
        for folder in ("src", "assets"):
            for path in sorted((ROOT / folder).rglob("*")):
                if path.is_file() and path.name != ".DS_Store":
                    archive.write(path, path.relative_to(ROOT))
    print(f"Created {OUTPUT}")


if __name__ == "__main__":
    main()
