import pytest
from fastapi.testclient import TestClient

from data_service_engine.app import app


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def test_health_and_operations_catalog(client):
    assert client.get("/health").json() == {"status": "ok"}

    response = client.get("/operations")
    assert response.status_code == 200
    names = {op["name"] for op in response.json()}
    assert names == {"normalize-prices-eod", "calculate-portfolio-volatility"}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/types"),
        ("POST", "/types/ex_ante_vol/validate"),
        ("POST", "/runs"),
        ("POST", "/calculate"),
    ],
)
def test_removed_legacy_endpoints_return_404(client, method, path):
    response = client.request(method, path, json={})
    assert response.status_code == 404
