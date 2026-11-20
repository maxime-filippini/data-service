"""Export the operation contracts as JSON Schema, for generating the Worker's
TypeScript contracts:

    uv run engine export-schemas > ../../src/operations/schemas.json

`pnpm operations:generate` runs this and the TypeScript generator.
"""

import json

from .contracts import ErrorResponse
from .registry import operations


def export_schemas() -> dict:
    """Each operation's description, request and response JSON Schemas, plus
    the shared error response. Stable key order, so the file diffs cleanly."""
    return {
        "operations": {
            name: {
                "description": operation.description,
                "request": operation.request.model_json_schema(),
                "response": operation.response.model_json_schema(),
            }
            for name, operation in sorted(operations().items())
        },
        "error": ErrorResponse.model_json_schema(),
    }


def export_json() -> str:
    return json.dumps(export_schemas(), indent=2, sort_keys=True) + "\n"
