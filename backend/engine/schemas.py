"""Pydantic models for the two final-stage LLM outputs (protocol, summary),
matching the JSON contract their own prompts document -- `FINAL_SYSTEM` and
`SUMMARY_FINAL_SYSTEM` in prompts.py. Not request/response schemas; those
live under meeting/api/schemas/.
"""
import typing

import pydantic


class Participant(pydantic.BaseModel):
    name: str
    position: str = ''


class AgendaItem(pydantic.BaseModel):
    topic: str
    speaker: str = ''
    decisions: list[str] = []


class ProtocolFinal(pydantic.BaseModel):
    participants: list[Participant] = []
    agenda_items: list[AgendaItem] = []


class Assignment(pydantic.BaseModel):
    assignee: str
    task: str
    deadline: str = ''
    # The track's must-have list names a priority on every action item.
    priority: typing.Literal['высокий', 'средний', 'низкий'] = 'средний'


class SummaryTopic(pydantic.BaseModel):
    topic: str
    discussion: str = ''
    key_arguments: list[str] = []
    assignments: list[Assignment] = []


class Decision(pydantic.BaseModel):
    decision: str


class IssueRisk(pydantic.BaseModel):
    type: typing.Literal['проблема', 'риск', 'блокер']
    issue: str
    impact: str = ''


class SummaryFinal(pydantic.BaseModel):
    executive_summary: str = ''
    topics: list[SummaryTopic] = []
    decisions: list[Decision] = []
    issues_and_risks: list[IssueRisk] = []
