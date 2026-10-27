"""Owned, per-meeting generation tasks, independent of HTTP response lifetime."""
import asyncio
import logging
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Callable


@dataclass(eq=False)
class GenerationJob:
    meeting_id: str
    task: asyncio.Task | None = None
    cancelled: bool = False
    committed: bool = False
    error: Exception | None = None


logger = logging.getLogger("steppe.generation")

_current_job: ContextVar[GenerationJob | None] = ContextVar('generation_job', default=None)


class GenerationJobs:
    def __init__(self, write_status: Callable):
        self.jobs: dict[str, GenerationJob] = {}
        self.write_status = write_status

    def active(self, meeting_id):
        job = self.jobs.get(meeting_id)
        return job if job and not job.task.done() else None

    def check(self, meeting_id):
        """Fence every continuation/write, even if a provider swallows cancellation."""
        job = _current_job.get()
        if job is None or job.meeting_id != meeting_id or job.cancelled or self.jobs.get(meeting_id) is not job:
            raise asyncio.CancelledError()

    def start(self, meeting_id, generate):
        if self.active(meeting_id):
            raise ValueError('Generation already running')
        job = GenerationJob(meeting_id)
        self.write_status(meeting_id, 'generating', '')
        self.jobs[meeting_id] = job

        async def run():
            token = _current_job.set(job)
            try:
                self.check(meeting_id)
                await generate(meeting_id)
                self.check(meeting_id)
            except Exception as error:
                job.error = error
                logger.exception("Generation failed for meeting %s", meeting_id)
            finally:
                _current_job.reset(token)

        job.task = asyncio.create_task(run(), name=f'protocol:{meeting_id}')
        job.task.add_done_callback(lambda _: self.finish(job))
        return job

    def finish(self, job):
        if self.jobs.get(job.meeting_id) is not job or not job.task.done():
            return
        # Called also for a task cancelled before its coroutine's first turn.
        if job.committed:
            self.write_status(job.meeting_id, 'completed', '')
        elif job.cancelled or job.task.cancelled():
            # An exception raised while unwinding still means the owned task ended.
            self.write_status(job.meeting_id, 'cancelled', '')
        elif job.error:
            self.write_status(job.meeting_id, 'error', 'Generation error: ' + str(job.error))
        else:
            self.write_status(job.meeting_id, 'completed', '')
        self.jobs.pop(job.meeting_id, None)

    def mark_committed(self, meeting_id):
        self.check(meeting_id)
        _current_job.get().committed = True

    async def stop(self, meeting_id, timeout=15):
        job = self.jobs.get(meeting_id)
        if job is None:
            return
        if not job.cancelled and not job.task.done():
            job.cancelled = True
            if not job.committed:
                self.write_status(meeting_id, 'cancelling', '')
            job.task.cancel()
        # wait() never forwards request cancellation or a second cancel into
        # provider cleanup. Duplicate Stop callers share exactly the same task.
        done, _ = await asyncio.wait([job.task], timeout=timeout)
        if not done:
            raise TimeoutError('Очистка запроса ещё выполняется. Повторите остановку.')
        self.finish(job)

    async def shutdown(self):
        await asyncio.gather(*(self.stop(key) for key in list(self.jobs)), return_exceptions=True)
