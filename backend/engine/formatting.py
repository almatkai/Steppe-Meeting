"""Structured artifact to the document a user reads.

Pure string assembly, ported from the backend this replaces. The layout is the
one people already receive and sign, so it is reproduced rather than improved.

The document is dated with the generation date, which is what the previous
backend did. Now that meetings carry ``meeting_date`` that is arguably wrong,
but changing it changes the document, so it is raised in the design note rather
than fixed in passing.
"""
import datetime

_LABELS = {
    'ru': {
        'title': 'ПРОТОКОЛ',
        'city': 'г. Астана',
        'participants': 'Присутствовали:',
        'summary_title': 'КРАТКОЕ СОДЕРЖАНИЕ',
        'topics': 'Обсуждённые вопросы:',
        'decisions': 'Решения:',
        'assignments': 'Поручения:',
        'issues_and_risks': 'Проблемы и риски:',
        'type_проблема': 'Проблема',
        'type_риск': 'Риск',
        'type_блокер': 'Блокер',
    },
    'kz': {
        'title': 'ХАТТАМА',
        'city': 'Астана қаласы',
        'participants': 'Қатысқандар:',
        'summary_title': 'ҚЫСҚАША МАЗМҰНЫ',
        'topics': 'Талқыланған мәселелер:',
        'decisions': 'Шешімдер:',
        'assignments': 'Тапсырмалар:',
        'issues_and_risks': 'Мәселелер мен тәуекелдер:',
        'type_проблема': 'Мәселе',
        'type_риск': 'Тәуекел',
        'type_блокер': 'Блокер',
    },
    'en': {
        'title': 'MINUTES',
        'city': 'Astana',
        'participants': 'Present:',
        'summary_title': 'MEETING SUMMARY',
        'topics': 'Topics discussed:',
        'decisions': 'Decisions:',
        'assignments': 'Action items:',
        'issues_and_risks': 'Issues and risks:',
        'type_проблема': 'Issue',
        'type_риск': 'Risk',
        'type_блокер': 'Blocker',
    },
}

_MONTHS = {
    'ru': ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
           'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    'kz': ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде',
           'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'],
    'en': ['January', 'February', 'March', 'April', 'May', 'June',
           'July', 'August', 'September', 'October', 'November', 'December'],
}


def _today(language: str) -> str:
    now = datetime.datetime.now()
    months = _MONTHS.get(language, _MONTHS['ru'])

    return f'{now.day:02d} {months[now.month - 1]} {now.year}'


def protocol_text(protocol: dict, language: str) -> str:
    """Render the official protocol. Empty in, empty out."""
    labels = _LABELS.get(language, _LABELS['ru'])
    participants = protocol.get('participants') or []
    agenda_items = protocol.get('agenda_items') or []

    if not participants and not agenda_items:
        return ''

    lines = [labels['title'], '', f"{labels['city']}\t№\t{_today(language)}", '']

    if participants:
        lines.append(labels['participants'])
        for person in participants:
            name = person.get('name') or ''
            position = person.get('position') or ''
            lines.append(f'    {name} – {position}' if position else f'    {name}')
        lines.append('')

    number = 1
    for item in agenda_items:
        decisions = item.get('decisions') or []

        # An item with no decisions is a heading with nothing under it, which
        # in a signed document reads as something left out.
        if not decisions:
            continue

        lines.append(f"{number}. {item.get('topic') or ''}")

        if item.get('speaker'):
            lines.append(f"({item['speaker']})")

        lines.append('')

        for position, decision in enumerate(decisions, 1):
            lines.append(f'    {number}.{position}. {decision}')

        lines.append('')
        number += 1

    return '\n'.join(lines)


def summary_text(summary: dict, language: str) -> str:
    """Render the summary. Empty in, empty out."""
    labels = _LABELS.get(language, _LABELS['ru'])
    executive = (summary.get('executive_summary') or '').strip()
    topics = summary.get('topics') or []
    decisions = summary.get('decisions') or []
    issues_and_risks = summary.get('issues_and_risks') or []

    if not executive and not topics and not decisions and not issues_and_risks:
        return ''

    lines = [labels['summary_title'], '']

    if executive:
        lines.extend([executive, ''])

    if topics:
        lines.append(labels['topics'])
        for number, topic in enumerate(topics, 1):
            lines.append(f"{number}. {topic.get('topic') or ''}")
            if topic.get('discussion'):
                lines.append(f"    {topic['discussion']}")

            key_arguments = topic.get('key_arguments') or []
            for argument in key_arguments:
                lines.append(f"    • {argument}")

            assignments = topic.get('assignments') or []
            if assignments:
                lines.append(f"    {labels['assignments']}")
                for assignment in assignments:
                    if not isinstance(assignment, dict):
                        continue
                    assignee = (assignment.get('assignee') or '').strip()
                    task = (assignment.get('task') or '').strip()
                    deadline = (assignment.get('deadline') or '').strip()

                    if not assignee or not task:
                        continue

                    entry = f'        {assignee}: {task}'
                    if deadline:
                        entry += f' ({deadline})'
                    lines.append(entry)

        lines.append('')

    if decisions:
        lines.append(labels['decisions'])
        for number, decision in enumerate(decisions, 1):
            lines.append(f"{number}. {decision.get('decision') or ''}")
        lines.append('')

    if issues_and_risks:
        lines.append(labels['issues_and_risks'])
        for item in issues_and_risks:
            if not isinstance(item, dict):
                continue

            item_type = (item.get('type') or '').strip()
            issue = (item.get('issue') or '').strip()
            impact = (item.get('impact') or '').strip()

            type_label = labels.get(f'type_{item_type}', item_type)
            line = f'    [{type_label}] {issue}'
            if impact:
                line += f' — {impact}'
            lines.append(line)
        lines.append('')

    return '\n'.join(lines)
