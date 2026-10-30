import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.tsx')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { STTRecommendationLabels, STTRecommendationDetails } = await import('../src/components/settings/STTRecommendation.tsx');
const render = (Component, recommendation) => renderToStaticMarkup(React.createElement(Component, { recommendation }));
const measured = { labels: ['Лучший в целом', 'Лучший для казахского'], use_case: null, use_case_caveat: null, note: 'Для русского и казахского', result: 'WER 5,9 %', basis: 'Маленький корпус FLEURS' };

test('measured labels and capability caveat stay visible outside collapsed evidence', () => {
  const winners = render(STTRecommendationLabels, measured);
  assert.match(winners, /Лучший в целом/);
  assert.match(winners, /Лучший для казахского/);
  assert.doesNotMatch(winners, /<details|Маленький корпус/);
  const english = render(STTRecommendationLabels, { ...measured, labels: ['Лучший для русского'], use_case: 'Для рус + англ', use_case_caveat: 'английский не сравнивали', note: null });
  assert.match(english, /Для рус \+ англ/);
  assert.match(english, /английский не сравнивали/);
  assert.doesNotMatch(english, /Лучший для рус \+ англ/);
});

test('evidence uses native keyboard disclosure and cannot select the parent model card', () => {
  const evidence = render(STTRecommendationDetails, measured);
  assert.match(evidence, /<details/);
  assert.match(evidence, /<summary[^>]*>Как определено<\/summary>/);
  assert.match(evidence, /Маленький корпус FLEURS/);
  const element = STTRecommendationDetails({ recommendation: measured });
  let stopped = false;
  element.props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

test('old backends and unlabelled models add no empty UI, and unavailable winners lose labels', () => {
  for (const Component of [STTRecommendationLabels, STTRecommendationDetails]) {
    assert.equal(render(Component, undefined), '');
    assert.equal(render(Component, null), '');
  }
  const unavailable = render(STTRecommendationLabels, { ...measured, labels: [], note: 'Требует Apple Silicon' });
  assert.doesNotMatch(unavailable, /Лучший в целом|Лучший для казахского/);
  assert.match(unavailable, /Требует Apple Silicon/);
});
