import argparse
import json
from pathlib import Path

from .models import Manifest
from .runtime import run


def main():
    """Run one job manifest locally, e.g. to debug a failed job."""
    parser = argparse.ArgumentParser(description="Process one job manifest")
    parser.add_argument("manifest", type=Path, help="Path to a job manifest JSON file")
    args = parser.parse_args()
    manifest = Manifest.model_validate_json(args.manifest.read_text())
    print(json.dumps({"outputEtag": run(manifest)}))
