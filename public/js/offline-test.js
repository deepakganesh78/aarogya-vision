import '/vendor/material.js';
import { SIGN_IDS, ageToDays } from '/shared/dangerSigns.js';
import { describeReason, levelRank, triageAssessment } from '/shared/triage.js';
import { el, setChildren } from './dom.js';
import { hydrateIcons } from './icons.js';

// Runs the stored test cases through the rules the phone uses offline: no AI, no server, nothing saved.
const LEVEL_TEXT = { URGENT: 'Urgent: refer now', PRIORITY: 'Doctor review today', ROUTINE: 'No danger sign' };
const $ = (s) => document.querySelector(s);

function run(c) {
  const patient = { ...c.patient, ageDays: ageToDays(c.patient.ageValue, c.patient.ageUnit) };
  const signs = c.checklistAllNo ? Object.fromEntries(SIGN_IDS.map((id) => [id, 'no'])) : undefined;
  return triageAssessment({ patient, assessment: { notes: c.note, ...(signs ? { signs } : {}) } });
}

function who(p) {
  const bits = [`${p.ageValue} ${p.ageUnit}`, p.sex];
  if (p.pregnant) bits.push(`pregnant${p.pregnancyMonths ? ` ${p.pregnancyMonths} m` : ''}`);
  return `${p.name}, ${bits.join(', ')}`;
}

const label = (level) => el('span', { className: `level-label level-${level}` }, LEVEL_TEXT[level]);

let cases = [];

function runAll() {
  let pass = 0;
  let under = 0;
  let over = 0;
  const rows = cases.map((c) => {
    const r = run(c);
    const diff = levelRank(r.level) - levelRank(c.expect);
    if (diff === 0) pass += 1;
    else if (diff < 0) under += 1;
    else over += 1;
    return el(
      'tr',
      { className: diff < 0 ? 'under' : '' },
      el('td', {}, c.label),
      el('td', {}, who(c.patient)),
      el('td', { lang: c.language }, c.note),
      el('td', {}, label(c.expect)),
      el('td', {}, label(r.level), diff < 0 ? el('div', { className: 'warn' }, 'Under-triage') : diff > 0 ? el('div', { className: 'on-surface-variant' }, 'More cautious') : null),
      el('td', {}, el('ul', { className: 'reasons' }, ...r.reasons.map((x) => el('li', {}, describeReason(x, 'en', { forDoctor: true })))))
    );
  });
  setChildren($('#rows'), ...rows);
  const kpi = (value, text, cls = '') => el('div', { className: `kpi ${cls}` }, el('span', { className: 'kpi__value' }, String(value)), el('span', { className: 'kpi__label md-typescale-body-medium' }, text));
  setChildren($('#summary'), kpi(cases.length, 'Cases'), kpi(pass, 'Match expected'), kpi(over, 'More cautious than expected'), kpi(under, 'Under-triage (must be 0)', under ? 'kpi--urgent' : ''));
}

function runCustom(e) {
  e.preventDefault();
  const months = Number($('#c-months').value) || 0;
  const sex = $('#c-sex').value || 'female';
  const c = {
    patient: { name: 'Test', ageValue: Number($('#c-age').value) || 0, ageUnit: $('#c-unit').value || 'years', sex, pregnant: sex === 'female' && months > 0, pregnancyMonths: months || null },
    note: String($('#c-note').value || '')
  };
  const r = run(c);
  setChildren(
    $('#c-result'),
    el('div', { className: `level-surface level-${r.level}` }, el('h3', { className: 'md-typescale-title-large' }, LEVEL_TEXT[r.level])),
    el('ul', { className: 'reasons md-typescale-body-medium' }, ...r.reasons.map((x) => el('li', {}, describeReason(x, 'en', { forDoctor: true }))))
  );
}

async function start() {
  hydrateIcons();
  cases = (await (await fetch('/offline-test/cases.json')).json()).cases;
  runAll();
  $('#run-all').addEventListener('click', runAll);
  $('#custom').addEventListener('submit', runCustom);
  $('#c-run').addEventListener('click', runCustom);
}

start();
