"""Immutable provider selection owned by one generation attempt.

The context propagates to chunk tasks and threads without changing settings used
by independent meetings or chat requests. Credentials never enter public identity.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass(frozen=True)
class GenerationRoute:
    mode: str
    provider: str
    model: str
    path: str = field(default='', repr=False)
    base_url: str = field(default='', repr=False)
    api_key: str = field(default='', repr=False)
    timeout: float = 300.0

    def identity(self):
        return {'mode': self.mode, 'provider': self.provider, 'model': self.model}


_route: ContextVar[GenerationRoute | None] = ContextVar('generation_route', default=None)


def current_route():
    return _route.get()


@contextmanager
def use_route(route: GenerationRoute):
    token = _route.set(route)
    try:
        yield route
    finally:
        _route.reset(token)
