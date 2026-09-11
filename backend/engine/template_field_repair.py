"""Conservative, source-grounded upgrade of legacy auto-named date fields."""
import copy
import re
from dataclasses import asdict
from io import BytesIO

from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph

from . import docx_template


def date_repairs(original, stored_slots):
    """Only rename an unambiguous visual date at the same original location."""
    parsed = docx_template.parse_docx_template(original)
    existing_keys = {s['key'] for s in stored_slots}
    repairs = {}
    for date in parsed.slots:
        if date.value_type != 'date' or not date.marker_contexts:
            continue
        candidates = [s for s in stored_slots
                      if 'pole_' in s['key'] and not s.get('repeat')
                      and s.get('locations') == date.locations
                      and any(
                          raw in date.raw_markers or any(re.fullmatch(
                              r'\{\{\s*' + re.escape(s['key']) + r'\s+or\s+([\x27\"])'
                              + re.escape(marker) + r'\1\s*\}\}', raw,
                          ) for marker in date.raw_markers)
                          for raw in s.get('raw_markers', [])
                      )]
        dates_at_location = [s for s in parsed.slots
                             if s.value_type == 'date' and s.locations == date.locations]
        if len(candidates) != 1 or len(dates_at_location) != 1 or date.key in existing_keys:
            continue
        repairs[candidates[0]['key']] = date
    return repairs


def rebind_document(document, repairs):
    """Change only Jinja variable spans; retain runs, static text and manual edits."""
    parsed = docx_template.parse_docx_template(document)
    old_keys = {s.key for s in parsed.slots}
    if not set(repairs) <= old_keys:
        raise ValueError('Legacy date bindings do not match this template variant')
    doc = Document(BytesIO(document))
    roots = [doc.element]
    for section in doc.sections:
        roots.extend(part._element for part in (
            section.header, section.footer, section.first_page_header,
            section.first_page_footer, section.even_page_header, section.even_page_footer,
        ))
    seen = set()
    for root in roots:
        for element in root.iter(qn('w:p')):
            if element in seen:
                continue
            seen.add(element)
            paragraph = Paragraph(element, doc)
            text = paragraph.text
            spans = [(match.start(1), match.end(1), repairs[match.group(1)].key)
                     for match in docx_template.PLACEHOLDER_RE.finditer(text)
                     if match.group(1) in repairs]
            if spans:
                docx_template._replace_text_spans_in_paragraph(paragraph, text, spans)
    output = BytesIO()
    doc.save(output)
    result = output.getvalue()
    expected = (old_keys - repairs.keys()) | {s.key for s in repairs.values()}
    if {s.key for s in docx_template.parse_docx_template(result).slots} != expected:
        raise ValueError('Date repair changed unrelated template bindings')
    return result


def repair_metadata(row, repairs):
    slots = copy.deepcopy(row['slots'])
    for slot in slots:
        date = repairs.get(slot['key'])
        if date:
            old_key = slot['key']
            slot['raw_markers'] = [re.sub(r'\b' + re.escape(old_key) + r'\b', date.key, raw)
                                   for raw in slot.get('raw_markers', [])]
            slot.update({key: value for key, value in asdict(date).items()
                         if key in ('key', 'label', 'value_type', 'marker_contexts')})
    parsed = docx_template.ParsedTemplate(slots=[docx_template.Slot(**slot) for slot in slots])
    descriptor = docx_template.parsed_to_descriptor(parsed)
    profile = copy.deepcopy(row.get('template_profile'))
    if profile:
        for field in profile['fields']:
            date = repairs.get(field['key'])
            if date:
                field.update(key=date.key, purpose='date', structure='scalar',
                             semantic_meaning=(date.label + '. ' + date.marker_contexts[0]['marked_text']
                                               + ' Заменяй только отмеченный пропуск; неизвестную дату оставь пустой.'),
                             repeatable=False, blank_when_unsupported=True)
                field.pop('columns', None)
    return {'slots': slots, 'schema_json': descriptor['schema_json'], 'template_profile': profile}
