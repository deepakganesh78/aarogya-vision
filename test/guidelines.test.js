import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SIGN_IDS } from '../public/shared/dangerSigns.js';
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

  it('every danger sign has at least one guideline entry', () => {
    for (const id of SIGN_IDS) {
      assert.ok(guidelines.retrieve({ signIds: [id] }).some((r) => r.matchedSigns.includes(id)), id);
    }
  });

  it('returns nothing when there is no signal', () => {
    assert.deepEqual(guidelines.retrieve({ signIds: [], text: '', level: 'PRIORITY' }), []);
  });
});
