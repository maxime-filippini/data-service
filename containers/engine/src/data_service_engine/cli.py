import argparse
import json
import sys
from pathlib import Path

from .framework import registry
from .models import RunRequest
from .operations.schemas import export_json
from .runtime import run


def main():
    """List types, export operation schemas, or run one run request locally."""
    parser = argparse.ArgumentParser(description="Calculation engine")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("types", help="List calculation types")
    commands.add_parser(
        "export-schemas", help="Print the operation contracts as JSON Schema"
    )
    run_parser = commands.add_parser("run", help="Run one run request JSON file")
    run_parser.add_argument("request", type=Path)
    args = parser.parse_args()

    if args.command == "types":
        print(json.dumps([t.describe() for t in registry().values()], indent=2))
        return
    if args.command == "export-schemas":
        sys.stdout.write(export_json())
        return
    result = run(RunRequest.model_validate_json(args.request.read_text()))
    print(result.model_dump_json(by_alias=True))
    sys.exit(0 if result.status != "failed" else 1)
