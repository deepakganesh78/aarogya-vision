import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DANGER_SIGNS } from '../public/shared/dangerSigns.js';
import { loadGuidelines } from '../src/guidelines.js';

const guidelines = loadGuidelines();

describe('guideline retrieval', () => {
  it('cites very-severe-disease guidance for an infant with fever and poor feeding', () => {
    const refs = guidelines.retrieve({ signIds: ['fever', 'not_feeding_well'], level: 'URGENT' });
    assert.equal(refs[0].id, 'who-very-severe-disease');
    assert.deepEqual(refs[0].matchedSigns, ['not_feeding_well', 'fever']);
    assert.ok(refs.some((r) => r.id === 'pre-referral-care'));
    assert.ok(refs.every((r) => r.source.publisher && r.source.document));
  });

  it('every danger sign has at least one guideline entry for the patients it applies to', () => {
    const contexts = {
      young_infant: { youngInfant: true },
      older: { youngInfant: false, under5: false },
      child: { youngInfant: false, under5: true },
      pregnancy: { youngInfant: false, under5: false, pregnant: true },
      any: { youngInfant: false, under5: false }
    };
    for (const sign of DANGER_SIGNS) {
      const refs = guidelines.retrieve({ signIds: [sign.id], context: contexts[sign.group] });
      assert.ok(refs.some((r) => r.matchedSigns.includes(sign.id)), sign.id);
    }
  });

  it('cites only guidance written for the patient: adult guidance for an adult, ANC guidance in pregnancy', () => {
    const adult = guidelines.retrieve({ signIds: ['fever'], context: { youngInfant: false, under5: false } });
    assert.equal(adult[0].id, 'adult-fever');
    assert.ok(adult.every((r) => !['young_infant', 'child', 'under5'].includes(r.population)));
    const pregnant = guidelines.retrieve({ signIds: ['preg_bleeding'], context: { youngInfant: false, under5: false, pregnant: true } });
    assert.equal(pregnant[0].id, 'mohfw-anc-danger');
    assert.ok(pregnant[0].steps.ta.length > 0, 'has Tamil steps for the worker');
  });

  it('falls back to the doctor-review policy when there is no signal', () => {
    assert.deepEqual(
      guidelines.retrieve({ signIds: [], text: '', level: 'PRIORITY' }).map((r) => r.id),
      ['general-review']
    );
  });
});
