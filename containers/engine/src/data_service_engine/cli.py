import argparse
import json
import sys

from .operations.registry import operations
from .operations.schemas import export_json


def main():
    """List workflow operations or export their JSON Schemas."""
    parser = argparse.ArgumentParser(description="Workflow operation engine")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("operations", help="List registered workflow operations")
    commands.add_parser(
        "export-schemas", help="Print the operation contracts as JSON Schema"
    )
    args = parser.parse_args()

    if args.command == "operations":
        print(json.dumps([op.describe() for op in operations().values()], indent=2))
        return
    sys.stdout.write(export_json())
