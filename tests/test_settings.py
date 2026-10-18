import pytest
from pydantic import ValidationError

from data_service_processor import runtime
from data_service_processor.settings import ProcessorSettings

ENVIRONMENT = {
    "R2_ENDPOINT_URL": "https://account.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "access-key",
    "R2_SECRET_ACCESS_KEY": "secret-key",
}


@pytest.fixture
def environment(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for name, value in ENVIRONMENT.items():
        monkeypatch.setenv(name, value)


def test_dotenv_and_environment_precedence(environment, monkeypatch, tmp_path):
    monkeypatch.delenv("R2_ENDPOINT_URL")
    (tmp_path / ".env").write_text(
        "R2_ENDPOINT_URL=https://file.test\nR2_ACCESS_KEY_ID=file-key\n"
    )
    settings = ProcessorSettings()
    assert str(settings.r2_endpoint_url) == "https://file.test/"
    assert settings.r2_access_key_id.get_secret_value() == "access-key"
    assert "secret-key" not in repr(settings)
    assert "secret-key" not in settings.model_dump_json()


@pytest.mark.parametrize("name", ENVIRONMENT)
def test_missing_setting_rejected_before_creating_a_client(
    environment, monkeypatch, name
):
    monkeypatch.delenv(name)
    monkeypatch.setattr(
        runtime.boto3, "client", lambda *a, **k: pytest.fail("client created")
    )
    with pytest.raises(ValidationError) as error, runtime.s3_client():
        pytest.fail("Invalid settings must not yield a client")
    assert error.value.errors()[0]["loc"] == (name.lower(),)


@pytest.mark.parametrize(
    "name,value",
    [
        ("R2_ENDPOINT_URL", "ftp://example.test"),
        ("R2_ACCESS_KEY_ID", ""),
        ("R2_SECRET_ACCESS_KEY", ""),
    ],
)
def test_invalid_values_rejected(environment, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError):
        ProcessorSettings()
