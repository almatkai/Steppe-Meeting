import collections.abc
import logging
import typing

import backoff

MAX_RETRIES_DEFAULT = 3


def retry(
    exception: type[Exception] | tuple[type[Exception], ...] | None = Exception,
    max_retries: int | None = MAX_RETRIES_DEFAULT,
    max_time: int | collections.abc.Callable[[], int] | None = None,
    max_value: int | None = None,
    factor: int = 1,
    backoff_log_level: int = logging.INFO,
    giveup_log_level: int = logging.ERROR,
) -> typing.Callable[[typing.Any], typing.Awaitable[typing.Any]]:
    exc = RuntimeError(
        'A subclass of Exception type or tuple of '
        f'Exception types is required, not {type(exception)}',
    )

    if isinstance(exception, tuple):
        if not all(issubclass(e, Exception) for e in exception):
            raise exc

    elif not issubclass(exception, Exception):
        raise exc

    return backoff.on_exception(
        backoff.expo,
        exception,
        max_tries=max_retries,
        max_time=max_time,
        jitter=backoff.full_jitter,
        max_value=max_value,
        factor=factor,
        backoff_log_level=backoff_log_level,
        giveup_log_level=giveup_log_level,
    )


def retry_wrap(
    coro,
    exception: type[Exception] | tuple[type[Exception], ...] | None = Exception,
    max_retries: typing.Optional[int] = MAX_RETRIES_DEFAULT,
    max_time: typing.Optional[
        typing.Union[int, typing.Callable[[], int]]
    ] = None,
    max_value: typing.Optional[int] = None,
    factor: int = 1,
) -> typing.Callable:
    wrapped = retry(exception, max_retries, max_time, max_value, factor)(coro)
    return wrapped
