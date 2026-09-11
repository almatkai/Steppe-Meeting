from __future__ import annotations

import datetime
import re


def utcnow() -> datetime.datetime:
    """Return current datetime with UTC timezone."""
    return datetime.datetime.now(tz=datetime.timezone.utc)


class Duration:
    """Duration class for time intervals.

    Stores duration internally as milliseconds and provides conversion properties
    for different time units. Supports arithmetic operations.
    """
    def __init__(self, units: int):
        self._units = units

    @classmethod
    def from_seconds(cls, seconds: int | float) -> Duration:
        """Create Duration from seconds."""
        return cls(int(seconds * 1000))

    @classmethod
    def from_minutes(cls, minutes: int | float) -> Duration:
        """Create Duration from minutes."""
        return cls(int(minutes * 60 * 1000))

    @classmethod
    def from_hours(cls, hours: int | float) -> Duration:
        """Create Duration from hours."""
        return cls(int(hours * 60 * 60 * 1000))

    @property
    def millis(self) -> int:
        """Get duration in milliseconds."""
        return self._units

    @property
    def seconds(self) -> float:
        """Get duration in seconds."""
        return self._units / 1000

    @property
    def minutes(self) -> float:
        """Get duration in minutes."""
        return self._units / 1000 / 60

    @property
    def hours(self) -> float:
        """Get duration in hours."""
        return self._units / 1000 / 60 / 60

    def __mul__(self, other: int | Duration) -> Duration:
        if isinstance(other, int):
            return Duration(self._units * other)
        if isinstance(other, Duration):
            return Duration(self._units * other._units)
        return NotImplemented

    def __rmul__(self, other: int) -> Duration:
        if isinstance(other, int):
            return Duration(self._units * other)
        return NotImplemented

    def __add__(self, other: Duration) -> Duration:
        if isinstance(other, Duration):
            return Duration(self._units + other._units)
        return NotImplemented

    def __sub__(self, other: Duration) -> Duration:
        if isinstance(other, Duration):
            return Duration(self._units - other._units)
        return NotImplemented

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Duration):
            return self._units == other._units
        return NotImplemented

    def __lt__(self, other: Duration) -> bool:
        if isinstance(other, Duration):
            return self._units < other._units
        return NotImplemented

    def __le__(self, other: Duration) -> bool:
        if isinstance(other, Duration):
            return self._units <= other._units
        return NotImplemented

    def __gt__(self, other: Duration) -> bool:
        if isinstance(other, Duration):
            return self._units > other._units
        return NotImplemented

    def __ge__(self, other: Duration) -> bool:
        if isinstance(other, Duration):
            return self._units >= other._units
        return NotImplemented

    def __repr__(self) -> str:
        return f"Duration({self._units}ms)"

    def __hash__(self) -> int:
        return hash(self._units)

    @classmethod
    def __get_pydantic_core_schema__(cls, _source, _handler):
        from pydantic_core import core_schema
        return core_schema.no_info_plain_validator_function(cls.parse)

    @classmethod
    def parse(cls, value: str | int | float | Duration) -> Duration:
        """Parse a duration from string like '1h', '30m', '120s', '5000ms', '7d' or numeric seconds."""
        if isinstance(value, Duration):
            return value
        if isinstance(value, (int, float)):
            return cls.from_seconds(value)
        match = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)', value.strip())
        if not match:
            raise ValueError(f"Invalid duration format: '{value}'. Use e.g. '1h', '30m', '120s', '5000ms', '7d'.")
        amount, unit = float(match.group(1)), match.group(2)
        if unit == 'ms':
            return cls(int(amount))
        if unit == 's':
            return cls.from_seconds(amount)
        if unit == 'm':
            return cls.from_minutes(amount)
        if unit == 'h':
            return cls.from_hours(amount)
        return cls(int(amount * 24 * 60 * 60 * 1000))


Millisecond = Duration(1)
Second = 1000 * Millisecond
Minute = 60 * Second
Hour = 60 * Minute
Day = 24 * Hour
