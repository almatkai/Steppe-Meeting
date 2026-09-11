"""Content-free generation events, correlated across concurrent language tasks."""
import asyncio
import contextvars
import copy
import datetime
import json
import logging
import time
from contextlib import contextmanager

logger = logging.getLogger(__name__)
_monitor = contextvars.ContextVar('generation_monitor', default=None)
_details = contextvars.ContextVar('generation_details', default={})


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def context():
    """Return correlation metadata for diagnostics outside event emission."""
    details = dict(_details.get())
    monitor = _monitor.get()
    if monitor:
        details.update(
            job_id=str(monitor.job['id']),
            template_id=str(monitor.job['template_id']),
            attempt=monitor.job['attempts'],
        )
    return details


@contextmanager
def scope(**details):
    token = _details.set({**_details.get(), **details})
    try:
        yield
    finally:
        _details.reset(token)


@contextmanager
def bind(monitor):
    token = _monitor.set(monitor)
    try:
        yield
    finally:
        _monitor.reset(token)


async def emit(event, **fields):
    monitor = _monitor.get()
    record = {**_details.get(), **fields, 'event': event, 'at': now()}
    if monitor:
        record.update(job_id=str(monitor.job['id']),
                      template_id=str(monitor.job['template_id']),
                      attempt=monitor.job['attempts'],
                      attempt_elapsed_seconds=round(time.monotonic() - monitor.started, 2))
    level = logging.ERROR if event == 'job_failed' else (
        logging.WARNING if event in ('llm_failed', 'llm_provider_failed', 'job_retrying', 'job_interrupted')
        else logging.INFO
    )
    logger.log(level, 'generation %s', json.dumps(record, ensure_ascii=False))
    if monitor:
        await monitor.record(record)


class Monitor:
    def __init__(self, job, persist):
        self.job = job
        self.persist = persist
        self.lock = asyncio.Lock()
        self.started = time.monotonic()
        self.data = copy.deepcopy(job.get('progress') or {})
        self.data.update(active_calls={}, started_at=now(), attempt=job['attempts'])
        self.data.pop('finished_at', None)
        self.data.pop('heartbeat_at', None)
        self.data.setdefault('events', [])
        self.data.setdefault('input_tokens', None)
        self.data.setdefault('output_tokens', None)
        self.data.setdefault('completed_calls', 0)
        self.data.setdefault('usage_missing_calls', 0)

    async def record(self, record):
        async with self.lock:
            data = self.data
            data['updated_at'] = record['at']
            data['attempt_elapsed_seconds'] = round(time.monotonic() - self.started, 2)
            event = record['event']
            if event == 'heartbeat':
                data['heartbeat_at'] = record['at']
            else:
                data['events'] = (data['events'] + [record])[-60:]
            if event == 'stage':
                data['stage'] = record['stage']
            if event == 'llm_started':
                data['active_calls'][record['call_id']] = record
            if event in ('llm_completed', 'llm_failed', 'llm_cancelled'):
                data['active_calls'].pop(record['call_id'], None)
            if event == 'llm_completed':
                data['completed_calls'] += 1
                for field in ('input_tokens', 'output_tokens'):
                    if record.get(field) is not None:
                        data[field] = (data[field] or 0) + record[field]
                if record.get('input_tokens') is None or record.get('output_tokens') is None:
                    data['usage_missing_calls'] += 1
            if event in ('job_completed', 'job_failed', 'job_retrying', 'job_interrupted'):
                data['finished_at'] = record['at']
                data['active_calls'] = {}
            # The model operation must not fail just because diagnostics cannot
            # be written. Leases are independently enforced by the pipeline.
            try:
                async with asyncio.timeout(5):
                    await self.persist(self.job, copy.deepcopy(data))
            except Exception as error:
                logger.warning('generation telemetry_write_failed job_id=%s error_type=%s',
                               self.job['id'], type(error).__name__)
