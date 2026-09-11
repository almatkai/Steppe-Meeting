"""Build one ordinary protocol and transfer it into an arbitrary DOCX contract."""

import hashlib
import json

from . import docx_template
from . import protocol
from . import template_generation

GENERATION_VERSION = 2


def build_protocol_source(
    generated_protocol: dict,
    *,
    agenda: str | None = None,
    participants: list[str] | None = None,
    confirmed_details: dict | None = None,
) -> dict:
    """Attach code-owned identities and provenance to the ordinary protocol."""
    confirmed_details = confirmed_details or {}
    for key, detail in confirmed_details.items():
        if (
            not isinstance(key, str)
            or not isinstance(detail, dict)
            or detail.get('value') in (None, '')
            or not isinstance(detail.get('source'), str)
            or not detail['source'].strip()
        ):
            raise ValueError('Confirmed protocol details require a value and provenance')

    topics = []
    for topic_index, agenda_item in enumerate(
        generated_protocol.get('agenda_items') or [], start=1,
    ):
        topic_id = f'topic-{topic_index:03d}'
        topics.append({
            'id': topic_id,
            'topic': agenda_item.get('topic', ''),
            'speaker': agenda_item.get('speaker', ''),
            'items': [
                {
                    'id': f'item-{topic_index:03d}-{item_index:03d}',
                    'text': decision,
                }
                for item_index, decision in enumerate(
                    agenda_item.get('decisions') or [], start=1,
                )
            ],
        })

    return {
        'generation_version': GENERATION_VERSION,
        'protocol': generated_protocol,
        'topics': topics,
        'meeting_inputs': {
            'agenda': {'value': agenda, 'source': 'user_agenda'},
            'participants': {
                'value': participants,
                'source': 'user_participants',
            },
        },
        'confirmed_details': confirmed_details,
    }


def source_fingerprint(
    transcript: str,
    *,
    agenda: str | None,
    participants: list[str] | None,
    confirmed_details: dict | None = None,
) -> str:
    """Identify the ordinary-protocol source shared by all detail levels.

    The ordinary protocol does not depend on detail level, template structure,
    or output language, so every level of one meeting reuses the same source.
    Detail levels differ only in wording, never in composition: every level
    covers the same source item IDs (concise \u2286 detailed \u2286 exhaustive
    holds trivially because all three cover the complete source).
    """
    payload = {
        'generation_version': GENERATION_VERSION,
        'transcript': transcript,
        'agenda': agenda,
        'participants': participants,
        'confirmed_details': confirmed_details or {},
    }
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def generation_fingerprint(
    parsed: docx_template.ParsedTemplate,
    transcript: str,
    *,
    agenda: str | None,
    participants: list[str] | None,
    confirmed_details: dict | None,
    additional_prompt: str,
    detail_level: str,
    template_version: int | None,
    template_profile: dict | None = None,
    output_language: str = 'Russian',
) -> str:
    """Identify every input that can change reusable checked source values."""
    payload = {
        'generation_version': GENERATION_VERSION,
        'output_language': output_language,
        'transcript': transcript,
        'agenda': agenda,
        'participants': participants,
        'confirmed_details': confirmed_details or {},
        'template_version': template_version,
        'template_structure': json.loads(
            template_generation._document_structure(parsed),
        ),
        'field_contracts': template_generation._field_contracts(parsed),
        'template_profile': template_profile or {},
        'additional_prompt': additional_prompt,
        'detail_level': detail_level,
    }
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


async def generate(
    parsed: docx_template.ParsedTemplate,
    transcript: str,
    *,
    agenda: str | None = None,
    participants: list[str] | None = None,
    confirmed_details: dict | None = None,
    template_profile: dict | None = None,
    additional_prompt: str = '',
    detail_level: str = 'concise',
    output_language: str = 'Russian',
    template_version: int | None = None,
    protocol_source: dict | None = None,
) -> dict:
    """Map one shared ordinary protocol into a DOCX result for one level.

    Pass the `protocol_source` produced for another detail level of the same
    meeting to reuse it instead of regenerating: the ordinary protocol does
    not depend on detail level, so all levels share one source and differ
    only in wording. A caller-supplied source must carry a matching
    `source_fingerprint`.
    """
    if not transcript or not transcript.strip():
        raise template_generation.TemplateGenerationError(
            'The meeting has no transcript', retryable=False,
        )

    expected_source = source_fingerprint(
        transcript,
        agenda=agenda,
        participants=participants,
        confirmed_details=confirmed_details,
    )
    if protocol_source is None:
        try:
            generated_protocol = await protocol.generate(
                transcript,
                participants=participants,
                agenda=agenda,
            )
        except protocol.GenerationError as error:
            raise template_generation.TemplateGenerationError(str(error)) from error

        protocol_source = build_protocol_source(
            generated_protocol,
            agenda=agenda,
            participants=participants,
            confirmed_details=confirmed_details,
        )
        protocol_source['source_fingerprint'] = expected_source
    elif protocol_source.get('source_fingerprint') != expected_source:
        raise template_generation.TemplateGenerationError(
            'Shared protocol source does not match the meeting inputs',
            retryable=False,
        )
    transferred = await template_generation.generate_protocol_template_values(
        parsed,
        additional_prompt,
        transcript,
        protocol_source=protocol_source,
        output_language=output_language,
        template_profile=template_profile,
        detail_level=detail_level,
    )
    return {
        'generation_version': GENERATION_VERSION,
        'generation_fingerprint': generation_fingerprint(
            parsed,
            transcript,
            agenda=agenda,
            participants=participants,
            confirmed_details=confirmed_details,
            additional_prompt=additional_prompt,
            detail_level=detail_level,
            template_version=template_version,
            template_profile=template_profile,
            output_language=output_language,
        ),
        'protocol_source': protocol_source,
        **transferred,
    }


async def translate_values(
    parsed: docx_template.ParsedTemplate,
    generation_result: dict,
    target_language: str,
) -> dict:
    """Translate checked values without changing source identities or structure."""
    protocol_source = generation_result.get('protocol_source') or {}
    protected_names = [
        participant['name']
        for participant in (protocol_source.get('protocol') or {}).get('participants') or []
        if isinstance(participant, dict) and participant.get('name')
    ]
    return await template_generation.translate_template_values(
        parsed,
        generation_result['template_values'],
        target_language,
        preserve_structure=True,
        protected_strings=protected_names,
    )
