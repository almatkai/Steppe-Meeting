"""The protocol pipeline.

Extract commitments from each chunk, aggregate them, dedupe twice — once
cheaply on exact text and once with the model on meaning — then generate the
Russian protocol. Kazakh is a translation of that finished protocol, not a
second generation, so the two cannot disagree about what was decided.

Every failure raises. The backend this replaces returned an empty protocol when
the final stage failed and returned the Russian one when the translation failed,
and in both cases its caller stored the result and marked it complete.

``quick_dedup`` also drops the old service's per-topic ``chunks`` list (which
chunk each decision came from) — nothing downstream of this port reads it, so
it is not reproduced.
"""
import asyncio
import json
import logging
import re

import pydantic

from .core import retries
from .config import settings
from . import chunking
from . import llm
from . import prompts
from . import schemas

logger = logging.getLogger(__name__)

_PLACEHOLDER_SPEAKER_RE = re.compile(r'^SPEAKER_(\d+|UNKNOWN)$', re.IGNORECASE)

# Old backend's `extract_position_from_name`: a participant string may carry
# its position in parens, e.g. "Иванов И.И. (директор)" -- split it out here
# so the rest of the pipeline works with {name, position} pairs the way the
# old backend's structured request schema always provided them.
_POSITION_RE = re.compile(r'^(.+?)\s*\(([^)]+)\)\s*$')


def _parse_participants(participants: list[str] | None) -> list[dict]:
    """Flat participant strings -> `{name, position}` pairs."""
    parsed = []
    for entry in participants or []:
        match = _POSITION_RE.match(entry)
        if match:
            parsed.append({'name': match.group(1), 'position': match.group(2)})
        else:
            parsed.append({'name': entry, 'position': ''})

    return parsed


class GenerationError(Exception):
    """Raises when the protocol could not be produced."""


def _normalize(text: str) -> str:
    """Fold a decision for comparison: case, spacing and trailing punctuation."""
    return text.lower().strip().replace('  ', ' ').replace('"', '').replace('.', '')


def _normalize_topic_name(name: str | None) -> str:
    """Fold a topic name for matching: lowercase, collapse internal whitespace."""
    if not name:
        return ''
    return ' '.join(name.lower().strip().split())


def _unique(items: list) -> list:
    """Drop repeats, keeping the first-seen original rather than its folded form."""
    seen = set()
    unique = []

    for item in items:
        if not item:
            continue

        folded = _normalize(item)
        if folded not in seen:
            seen.add(folded)
            unique.append(item)

    return unique


def _real_speakers(speakers: list | None) -> list:
    """Drop a raw diarization id the model echoed back despite the prompt's
    instruction not to -- a SPEAKER_NN placeholder must never reach a
    generated document as if it were a person's name.

    ``SPEAKER_UNKNOWN`` counts too: that is what ``stt.build_transcript_text``
    labels a segment with no speaker at all, so it is what the model sees
    throughout an undiarized meeting or any transcript migrated from the old
    backend, and it is no more a person's name than ``SPEAKER_00`` is.
    """
    return [
        speaker for speaker in (speakers or [])
        if speaker and not _PLACEHOLDER_SPEAKER_RE.match(speaker.strip())
    ]


def quick_dedup(chunk_results: list[dict], participants: list[dict] | None = None) -> dict:
    """Aggregate the chunks and drop exact repeats.

    Chunks overlap, so the same commitment routinely arrives two or three times
    with trivial differences in punctuation. Removing those here means the model
    doing the semantic pass sees a much shorter list.
    """
    planned: dict[str, dict] = {}
    unplanned: dict[str, dict] = {}
    action_items: list[dict] = []
    agenda_translated: list = []

    for result in chunk_results:
        if not agenda_translated and result.get('agenda_translated'):
            agenda_translated = result['agenda_translated']

        for topic in result.get('planned_topics') or []:
            name = topic.get('agenda_item', '')
            if not name:
                continue

            entry = planned.setdefault(
                name, {'agenda_item': name, 'speakers': set(), 'decisions': []},
            )
            entry['speakers'].update(_real_speakers(topic.get('speakers')))
            entry['decisions'].extend(topic.get('decisions') or [])

        for topic in result.get('unplanned_topics') or []:
            topic_id = topic.get('topic_id', 'other_issues')

            entry = unplanned.setdefault(topic_id, {
                'topic_id': topic_id,
                'topic_name': topic.get('topic_name', 'Прочие вопросы'),
                'speakers': set(),
                'decisions': [],
            })
            entry['speakers'].update(_real_speakers(topic.get('speakers')))
            entry['decisions'].extend(topic.get('decisions') or [])

        action_items.extend(result.get('action_items') or [])

    for group in (planned, unplanned):
        for entry in group.values():
            entry['decisions'] = _unique(entry['decisions'])
            entry['speakers'] = list(entry['speakers'])

    seen_actions = set()
    unique_actions = []
    for item in action_items:
        if not item or not item.get('task'):
            continue

        key = f"{item['task']}|||{item.get('assignee', 'none')}".lower().strip()
        if key not in seen_actions:
            seen_actions.add(key)
            unique_actions.append(item)

    return {
        'input_participants': participants or [],
        'planned_topics': list(planned.values()),
        'unplanned_topics': list(unplanned.values()),
        'action_items': unique_actions,
        'metadata': {
            'agenda_translated': agenda_translated,
            'total_chunks_processed': len(chunk_results),
        },
    }


async def _extract_with_retry(chunk_id: int, messages: list) -> dict:
    """Run one chunk's extraction messages, retrying via the shared retry helper."""
    async def _complete(messages):
        return await llm.complete_json(messages)

    call = retries.retry_wrap(
        _complete,
        exception=llm.LLMError,
        max_retries=settings.GENERATION_CHUNK_RETRIES + 1,
        max_value=0,
        factor=1,
    )

    try:
        result = await call(messages)
    except llm.LLMError as e:
        raise GenerationError(f'chunk {chunk_id} could not be read: {e}') from e

    result['chunk_id'] = chunk_id
    return result


async def _enforce_agenda_topics(
    deduplicated: dict, agenda: str, agenda_translated: list,
) -> dict:
    """Force every extracted topic onto an agenda item.

    Non-fatal: on any failure this returns ``deduplicated`` unchanged rather
    than failing the whole generation, matching the old backend's own choice
    for this specific stage -- under-organizing by agenda was judged better
    than losing a protocol over one classification call.
    """
    all_topics = []
    for topic in deduplicated.get('planned_topics', []):
        all_topics.append({
            'topic_name': topic.get('agenda_item', ''),
            'decisions': topic.get('decisions', []),
            'speakers': topic.get('speakers', []),
        })
    for topic in deduplicated.get('unplanned_topics', []):
        all_topics.append({
            'topic_name': topic.get('topic_name', 'Прочие вопросы'),
            'decisions': topic.get('decisions', []),
            'speakers': [],
        })

    try:
        result = await llm.complete_json([
            {'role': 'system', 'content': prompts.ENFORCE_AGENDA_SYSTEM},
            {'role': 'user', 'content': prompts.enforce_agenda_user(agenda, all_topics)},
        ])
    except llm.LLMError:
        logger.warning('Agenda-topic enforcement failed, keeping the deduplicated input')
        return deduplicated

    agenda_topics_russian = result.get('agenda_topics_russian', [])
    topic_mappings = result.get('topic_mappings', [])

    agenda_topic_data = {}
    for topic in agenda_topics_russian:
        translated = topic.get('translated', '')
        if translated:
            attendees = topic.get('attendees', [])
            speakers = [a.get('name', '') for a in attendees if a.get('name')]
            agenda_topic_data[translated] = {
                'agenda_item': translated, 'speakers': speakers, 'decisions': [],
            }

    other_issues_decisions = []
    _OTHER_ISSUES_NAMES = {'прочие вопросы', 'other issues', 'басқа мәселелер'}

    for mapping in topic_mappings:
        matched = mapping.get('matched_agenda_topic', '')
        decisions = mapping.get('decisions', [])

        if matched.lower().strip() in _OTHER_ISSUES_NAMES:
            other_issues_decisions.extend(decisions)
        elif matched in agenda_topic_data:
            agenda_topic_data[matched]['decisions'].extend(decisions)
        else:
            found = False
            for topic_name in agenda_topic_data:
                if _normalize_topic_name(matched) == _normalize_topic_name(topic_name):
                    agenda_topic_data[topic_name]['decisions'].extend(decisions)
                    found = True
                    break
            if not found:
                other_issues_decisions.extend(decisions)

    def _dedup_decisions(decisions: list[str]) -> list[str]:
        seen = set()
        unique = []
        for decision in decisions:
            normalized = _normalize_topic_name(decision)
            if normalized not in seen:
                seen.add(normalized)
                unique.append(decision)
        return unique

    final_planned_topics = []
    for topic_data in agenda_topic_data.values():
        topic_data['decisions'] = _dedup_decisions(topic_data['decisions'])
        if topic_data['decisions']:
            final_planned_topics.append(topic_data)

    final_unplanned_topics = []
    if other_issues_decisions:
        final_unplanned_topics = [{
            'topic_id': 'other_issues',
            'topic_name': 'Прочие вопросы',
            'speakers': [],
            'decisions': _dedup_decisions(other_issues_decisions),
        }]

    return {
        'participants': deduplicated.get('participants', []),
        'planned_topics': final_planned_topics,
        'unplanned_topics': final_unplanned_topics,
        'action_items': deduplicated.get('action_items', []),
    }


_OTHER_ISSUES_TOPIC_NAMES = frozenset({'прочие вопросы', 'басқа мәселелер', 'other issues'})


def _strip_unplanned_topics(result: dict) -> dict:
    """Drop the 'Other issues' topic and clear every remaining speaker.

    Old backend applied this whenever there was no agenda -- an 'Other
    issues' bucket only means something when there's an agenda to contrast
    it against. This backend never ported it, so every protocol generated so
    far has carried a stray topic and populated speakers this function
    removes.
    """
    if 'agenda_items' not in result:
        return result

    result['agenda_items'] = [
        item for item in result['agenda_items']
        if item.get('topic', '').lower().strip() not in _OTHER_ISSUES_TOPIC_NAMES
    ]
    for item in result['agenda_items']:
        item['speaker'] = ''

    return result


# Kazakh letters folded to their nearest Russian equivalent, so a name typed
# in one script matches the same name the model returned in the other.
# Ү and Ұ both fold to У -- the old backend's table does not distinguish them.
_KAZAKH_FOLD = str.maketrans({
    'Қ': 'К', 'қ': 'к', 'Ө': 'О', 'ө': 'о', 'Ү': 'У', 'ү': 'у',
    'І': 'И', 'і': 'и', 'Ә': 'А', 'ә': 'а', 'Ғ': 'Г', 'ғ': 'г',
    'Ұ': 'У', 'ұ': 'у', 'Ң': 'Н', 'ң': 'н', 'Һ': 'Х', 'һ': 'х',
})


def _fold_kazakh_name(name: str) -> str:
    return name.translate(_KAZAKH_FOLD).lower().strip()


def _restore_participant_positions(
    output_participants: list[dict], original_participants: list[dict],
) -> list[dict]:
    """Fill in a participant's position when the model dropped it.

    Matches by name, after folding Kazakh letters to Russian and lowercasing
    both sides -- exact match only, no fuzzy matching. An unmatched name is
    left with whatever position it already had (usually empty); nothing
    raises.
    """
    if not original_participants:
        return output_participants

    lookup = {
        _fold_kazakh_name(person['name']): person['position']
        for person in original_participants
        if person.get('name') and person.get('position')
    }

    for person in output_participants:
        if person.get('position'):
            continue
        position = lookup.get(_fold_kazakh_name(person.get('name', '')))
        if position:
            person['position'] = position

    return output_participants


async def gather_chunks(pieces: list[dict], extract) -> list[dict]:
    """Read every chunk, in parallel up to a configured cap, and refuse to
    proceed on a gap.

    The old service filtered failures out of ``gather`` and carried on, so a
    protocol built from one chunk of ten looked exactly like one built from
    all ten. The concurrency cap keeps an unusually large — but
    under-the-word-limit — transcript from firing hundreds of simultaneous
    LLM requests.
    """
    semaphore = asyncio.Semaphore(settings.GENERATION_MAX_CONCURRENT_CHUNKS)

    async def _bounded(piece):
        async with semaphore:
            return await extract(piece)

    results = await asyncio.gather(
        *(_bounded(piece) for piece in pieces), return_exceptions=True,
    )

    failed = [r for r in results if isinstance(r, BaseException)]
    if failed:
        raise GenerationError(
            f'{len(failed)} of {len(pieces)} chunks could not be read: {failed[0]}',
        )

    return list(results)


async def stage(
    system: str, user: str, description: str,
    model_cls: type[pydantic.BaseModel] | None = None,
) -> dict:
    """Run one LLM stage. When `model_cls` is given, validate the reply
    against it and, on a schema mismatch, give the model one retry with the
    validation error shown back to it before raising.
    """
    messages = [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': user},
    ]

    retried = False
    while True:
        try:
            raw = await llm.complete_json(messages)
        except llm.LLMError as e:
            raise GenerationError(f'{description} failed: {e}') from e

        if model_cls is None:
            return raw

        try:
            return model_cls.model_validate(raw).model_dump()
        except pydantic.ValidationError as e:
            if retried:
                raise GenerationError(
                    f'{description}: schema validation failed after retry: {e}',
                ) from e
            retried = True
            messages = messages + [
                {'role': 'assistant', 'content': json.dumps(raw, ensure_ascii=False)},
                {'role': 'user', 'content': (
                    f'Твой JSON не прошёл проверку схемы. Ошибки:\n{e}\n\n'
                    'Верни ИСПРАВЛЕННЫЙ полный JSON. Ничего кроме JSON.'
                )},
            ]


async def generate(
    transcript_text: str, participants: list[str] | None = None, agenda: str | None = None,
) -> dict:
    """Produce the Russian protocol from a transcript."""
    parsed_participants = _parse_participants(participants)

    try:
        pieces = chunking.chunk(transcript_text, parsed_participants, agenda or '')
    except ValueError as e:
        raise GenerationError(str(e)) from e

    logger.info('Generating a protocol from %s chunks', len(pieces))

    async def _extract(piece):
        messages = [
            {'role': 'system', 'content': prompts.EXTRACTION_SYSTEM},
            {'role': 'user', 'content': prompts.extraction_user(
                text=piece['text'],
                participants=piece['participants'],
                chunk_id=piece['chunk_id'],
                total_chunks=piece['total_chunks'],
                agenda=piece['agenda'],
            )},
        ]
        return await _extract_with_retry(piece['chunk_id'], messages)

    extracted = await gather_chunks(pieces, _extract)
    aggregated = quick_dedup(extracted, parsed_participants)

    has_agenda = agenda is not None
    deduplicated = await stage(
        prompts.dedup_system(has_agenda), prompts.dedup_user(aggregated, has_agenda),
        'deduplication',
    )

    if has_agenda:
        deduplicated = await _enforce_agenda_topics(
            deduplicated, agenda, aggregated['metadata']['agenda_translated'],
        )

    result = await stage(
        prompts.FINAL_SYSTEM, prompts.final_user(deduplicated), 'protocol generation',
        schemas.ProtocolFinal,
    )

    if not has_agenda:
        result = _strip_unplanned_topics(result)

    if parsed_participants:
        result['participants'] = _restore_participant_positions(
            result.get('participants', []), parsed_participants,
        )

    return result


async def _translate(
    protocol_ru: dict,
    system_prompt: str,
    language_name: str,
    has_agenda: bool = False,
) -> dict:
    translated = await stage(
        system_prompt,
        prompts.translate_protocol_user(protocol_ru),
        f'protocol translation to {language_name}',
    )
    if not has_agenda:
        translated = _strip_unplanned_topics(translated)
    return translated


async def translate(protocol_ru: dict, has_agenda: bool = False) -> dict:
    """Translate a finished Russian protocol into Kazakh."""
    return await _translate(
        protocol_ru,
        prompts.TRANSLATE_PROTOCOL_SYSTEM,
        'Kazakh',
        has_agenda,
    )


async def translate_english(protocol_ru: dict, has_agenda: bool = False) -> dict:
    """Translate a finished Russian protocol into English."""
    return await _translate(
        protocol_ru,
        prompts.TRANSLATE_PROTOCOL_ENGLISH_SYSTEM,
        'English',
        has_agenda,
    )
