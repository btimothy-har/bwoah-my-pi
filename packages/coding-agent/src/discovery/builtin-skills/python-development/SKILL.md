---
name: python-development
description: "Apply when authoring or editing Python (.py) code, managing dependencies or environments with uv, or writing pytest tests: uv workflow, pydantic-first data modeling, modern typing, exception and logging discipline, pytest idioms."
---

# Python Development

Bundled `py-*` TTSR rules fire automatically on `.py` edits; this skill covers what they do not.

## uv workflow

Use `uv` for environments and dependencies. `uv run` executes inside the project environment, creating it and installing locked dependencies as needed — prefer it over manual venv activation.

```bash
uv init                      # new project: pyproject.toml + .python-version
uv add httpx                 # runtime dependency
uv add --dev pytest ruff     # dev dependency -> PEP 735 [dependency-groups]
uv run pytest                # run inside the project env
uv lock --upgrade            # refresh uv.lock
```

Dev dependencies live in PEP 735 `[dependency-groups]`, which `uv add --dev` writes. The legacy `[tool.uv]` dev table is deprecated; NEVER add to it. Commit `uv.lock`.

### Standalone scripts

PEP 723 inline metadata makes a script self-contained; `uv run script.py` builds an ephemeral environment from it — the enclosing project's dependencies are ignored:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///

import httpx
```

Add deps: `uv add --script script.py httpx`.

### CI

```yaml
- uses: astral-sh/setup-uv   # pin a current major or SHA; check its releases page
  with:
    enable-cache: true
- run: uv sync --locked --all-extras --dev
- run: uv run pytest
```

`--locked` fails CI when `uv.lock` is stale relative to `pyproject.toml`, catching uncommitted lockfile changes; `--frozen` skips that check.

### Docker

```dockerfile
COPY --from=ghcr.io/astral-sh/uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY . .
RUN uv sync --locked --no-dev
CMD ["uv", "run", "--no-sync", "python", "app.py"]
```

Pin the uv image tag. Dependencies install before the source copy (`--no-install-project`) so that layer caches across code changes; the second sync installs the project. `--no-sync` at runtime: the image synced at build; without it `uv run` re-verifies the environment on every container start and could reinstall dev dependencies.

### Workspaces

```toml
# root pyproject.toml
[tool.uv.workspace]
members = ["packages/*"]
```

`uv add ./packages/pkg-a` adds a member by path; `uv sync` installs the whole workspace.

## Data structures

Default to pydantic `BaseModel`. Reach for anything else only with a reason.

| Need | Use |
|------|-----|
| Default: validated, serializable data | pydantic `BaseModel` |
| No validation needed; hot path, many instances | `@dataclass(slots=True)` |
| Immutable AND hashable — dict keys, set members, unpacking | `NamedTuple` |
| Must stay a dict — legacy API, JSON passthrough | `TypedDict` |

```python
from pydantic import BaseModel, Field

class User(BaseModel):
    name: str = Field(min_length=1)
    email: str
    age: int = Field(ge=0)

user = User.model_validate(payload)   # raises ValidationError on bad data
data = user.model_dump()              # serialization built in
```

A dataclass silently accepts `User(name=123, email=None)`; pydantic validates at construction with the same effort.

App configuration: pydantic-settings, configured with `SettingsConfigDict`:

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_")

    database_url: str
    debug: bool = False

settings = Settings()  # reads APP_DATABASE_URL, APP_DEBUG
```

### Mutable defaults

NEVER use a mutable default argument or mutable class attribute — the object is created once and shared across every call or instance:

```python
# Bad — one list shared across all calls
def add(item, seen=[]):
    seen.append(item)

# Good
def add(item, seen=None):
    seen = [] if seen is None else seen
    seen.append(item)

# Bad — class attribute shared by every instance
class Config:
    values = []

# Good — per-instance list
@dataclass
class Config:
    values: list[str] = field(default_factory=list)
```

## Typing

- Modern syntax, consistently: `list[int]`, `dict[str, int]`, `str | None`; PEP 695 `type Alias = ...` and generic-class syntax where the project's `requires-python` allows 3.12+. Check `requires-python` before using 3.12-only syntax. NEVER import `Optional`/`List`/`Dict` from `typing` in new code.
- Annotate function signatures, return types, and public class attributes. Skip obvious locals (`name = "Alice"`).

## Errors and logging

Handler hygiene — bare/broad/silent `except`, `raise e`, catch-and-reraise — is covered by the bundled `py-*` rules. Beyond that:

- Raise specific domain exceptions under one application base — not `Exception` or `ValueError` — so callers can catch precisely:

```python
class AppError(Exception): ...
class NotFoundError(AppError): ...

raise NotFoundError(f"Order {order_id} not found")
```

Repeated message formatting at raise sites belongs in the exception class.

- Chain when converting inside a handler: `raise ValidationError(...) from e` keeps the original cause in the traceback; `raise ... from None` suppresses it deliberately.
- A handler that logs uses `logger.exception(...)`, which attaches the traceback; `logger.error(...)` does not.
- Enforce with Ruff: `extend-select = ["TRY", "B"]` — TRY002/TRY003/TRY400 (from tryceratops) plus B904 for `raise` without `from` inside `except`.
- Logging calls: pass lazy `%`-args or structured `extra={}`; both are good, pick per call site. Log at boundaries (external calls, database operations, user actions) with context IDs. NEVER log passwords, tokens, or PII.

## Testing (pytest)

- Patch where the name is looked up, not where it is defined:

```python
# Good — myapp.users did `from mailer import send_email`
mocker.patch("myapp.users.send_email")

# Bad — patches the defining module; myapp.users still holds its own reference
mocker.patch("mailer.send_email")
```

- Mock HTTP at the transport, not by patching `httpx.get`:

```python
def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"data": "value"})

client = httpx.Client(transport=httpx.MockTransport(handler))
```

Use `respx` when route-level matching is needed.

- Fixture factories with cleanup after `yield`:

```python
@pytest.fixture
def make_user(db_session):
    created = []

    def _make(email="test@example.com", **kwargs):
        user = User(email=email, **kwargs)
        db_session.add(user)
        db_session.commit()
        created.append(user)
        return user

    yield _make

    for user in created:
        db_session.delete(user)
    db_session.commit()
```

- Parametrize instead of duplicating tests; give complex cases `id=`:

```python
@pytest.mark.parametrize("email,valid", [
    pytest.param("user@example.com", True, id="simple"),
    pytest.param("user@", False, id="missing-domain"),
])
def test_email_validation(email, valid):
    assert is_valid_email(email) is valid
```

- Freeze datetime-dependent logic with freezegun; advance with `tick()`:

```python
from datetime import timedelta
from freezegun import freeze_time

def test_trial_duration():
    with freeze_time("2024-01-01") as frozen:
        trial = start_trial()
        frozen.tick(delta=timedelta(days=7))
        assert trial.days_remaining == 7
```

Production code takes the current time as `datetime.now(UTC)`; NEVER call it without a tz or use deprecated `utcnow()`.

- Test ASGI apps (FastAPI, Starlette) through httpx — no server, works in async tests:

```python
@pytest.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c

@pytest.mark.asyncio
async def test_create_user(client):
    response = await client.post("/users", json={"email": "a@b.com"})
    assert response.status_code == 201
```

- Filesystem: `tmp_path`. Captured output/logs: `capsys`/`caplog`.

## Library defaults

No project convention → httpx (HTTP), pydantic (models), typer (CLI), pathlib (paths), zoneinfo (time zones), tomllib/json (stdlib config).
