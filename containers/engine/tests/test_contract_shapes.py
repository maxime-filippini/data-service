from pathlib import Path

from tests.contract_shapes import export_json

REPO = Path(__file__).resolve().parents[3]


def test_the_generator_fixture_matches_the_pydantic_shapes():
    """The TypeScript generator's tests read this file; regenerate it as the
    module docstring of `tests/contract_shapes.py` says when it is stale (for
    example after a Pydantic upgrade changes its JSON Schema output)."""
    committed = REPO / "fixtures" / "operation-contracts" / "shapes.json"
    assert export_json() == committed.read_text()
