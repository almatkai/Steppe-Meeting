"""Shared shape for a process-lifetime singleton client.

llm.py, embeddings.py and vector_store.py each need "create once, reuse
until explicitly closed" for their own client type -- this is the
get-or-create step common to all three; each module still keeps its own
module-level ``_client`` global and ``close()`` function, since closing a
client differs by type (``aclose()`` vs ``close()``) and existing tests
already reset ``_client`` directly between runs.
"""
import typing

T = typing.TypeVar('T')


def get_or_create(current: T | None, factory: typing.Callable[[], T]) -> T:
    return current if current is not None else factory()
