"""Process logging: one JSON object per line, plain text only on a developer's terminal."""

from __future__ import annotations

import io
import json
import logging
import logging.config
import sys
from collections.abc import Iterator
from typing import Any

import pytest

from app import logs
from app.config import Settings


class Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


def record(message: str = "hello %s", *args: object, **extra: Any) -> logging.LogRecord:
    made = logging.getLogger("app.test").makeRecord(
        "app.test", logging.INFO, __file__, 1, message, args or ("world",), None, extra=extra
    )
    return made


def as_json(formatter: logging.Formatter, made: logging.LogRecord) -> dict[str, Any]:
    line = formatter.format(made)
    assert "\n" not in line
    parsed: dict[str, Any] = json.loads(line)
    return parsed


def test_json_lines_carry_level_logger_message_and_extras() -> None:
    entry = as_json(logs.JsonFormatter(), record(job_id="j1", attempt=2))
    assert entry["level"] == "INFO"
    assert entry["logger"] == "app.test"
    assert entry["message"] == "hello world"
    assert entry["job_id"] == "j1"
    assert entry["attempt"] == 2
    assert entry["ts"].endswith("Z")


def test_json_lines_skip_uvicorns_color_message() -> None:
    entry = as_json(logs.JsonFormatter(), record(color_message="\x1b[1mhello\x1b[0m"))
    assert "color_message" not in entry


def test_json_lines_render_values_json_cannot() -> None:
    entry = as_json(logs.JsonFormatter(), record(when=object))
    assert entry["when"] == str(object)


def test_exceptions_stay_on_one_line() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        made = logging.getLogger("app.test").makeRecord(
            "app.test", logging.ERROR, __file__, 1, "failed", (), sys.exc_info()
        )
    entry = as_json(logs.JsonFormatter(), made)
    assert "ValueError: boom" in entry["exc"]


def test_context_fields_join_every_line_in_their_block() -> None:
    formatter = logs.JsonFormatter()
    with logs.log_context(request_id="r1"), logs.log_context(user_id="u1"):
        inside = as_json(formatter, record())
    outside = as_json(formatter, record())
    assert (inside["request_id"], inside["user_id"]) == ("r1", "u1")
    assert "request_id" not in outside
    assert "user_id" not in outside


def test_a_records_own_field_wins_over_the_context() -> None:
    with logs.log_context(job_id="outer"):
        entry = as_json(logs.JsonFormatter(), record(job_id="inner"))
    assert entry["job_id"] == "inner"


def test_text_lines_read_naturally() -> None:
    with logs.log_context(request_id="r1"):
        line = logs.TextFormatter().format(record(job_id="j1"))
    assert "INFO app.test hello world" in line
    assert "job_id=j1" in line
    assert "request_id=r1" in line


@pytest.mark.parametrize(
    ("app_env", "stream", "expected"),
    [
        ("development", Tty(), logs.TextFormatter),
        ("development", io.StringIO(), logs.JsonFormatter),
        ("production", Tty(), logs.JsonFormatter),
        ("test", Tty(), logs.JsonFormatter),
    ],
)
def test_plain_text_only_on_a_development_terminal(
    app_env: str, stream: io.StringIO, expected: type[logging.Formatter]
) -> None:
    # model_copy skips validation: production's required settings are not under test.
    settings = Settings(_env_file=None).model_copy(update={"app_env": app_env})
    assert logs.formatter_class(settings, stream) is expected


@pytest.fixture
def restored_logging() -> Iterator[None]:
    """Put back the root and uvicorn loggers that ``configure_logging`` replaces."""
    names = ("", "uvicorn", "uvicorn.error", "uvicorn.access")
    saved = {
        name: (
            list(logging.getLogger(name).handlers),
            logging.getLogger(name).level,
            logging.getLogger(name).propagate,
        )
        for name in names
    }
    yield
    for name, (handlers, level, propagate) in saved.items():
        logger = logging.getLogger(name)
        logger.handlers = handlers
        logger.setLevel(level)
        logger.propagate = propagate


def test_configure_logging_sends_everything_through_one_root_handler(
    restored_logging: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    stream = io.StringIO()
    monkeypatch.setattr(sys, "stderr", stream)
    logs.configure_logging(Settings(_env_file=None, log_level="info"))
    root = logging.getLogger()
    [handler] = root.handlers
    assert isinstance(handler.formatter, logs.JsonFormatter)
    assert root.level == logging.INFO
    # uvicorn's own lines become JSON too; its access log is replaced by app.request.
    assert logging.getLogger("uvicorn").handlers == []
    assert logging.getLogger("uvicorn").propagate is True
    assert logging.getLogger("uvicorn.error").propagate is True
    logging.getLogger("uvicorn.error").info("Started server process")
    logging.getLogger("uvicorn.access").info("GET / 200")
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [line["message"] for line in lines] == ["Started server process"]


def test_logging_config_is_a_dict_uvicorn_can_take() -> None:
    config = logs.logging_config(Settings(_env_file=None))
    assert config["version"] == 1
    assert config["disable_existing_loggers"] is False
    assert config["root"]["handlers"] == ["stderr"]


def test_ensure_logging_leaves_a_configured_root_alone(restored_logging: None) -> None:
    sentinel = logging.NullHandler()
    logging.getLogger().handlers = [sentinel]
    logs.ensure_logging()
    assert logging.getLogger().handlers == [sentinel]


def test_ensure_logging_configures_a_bare_root(
    restored_logging: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "stderr", io.StringIO())
    logging.getLogger().handlers = []
    logs.ensure_logging()
    [handler] = logging.getLogger().handlers
    assert isinstance(handler.formatter, logs.JsonFormatter)
