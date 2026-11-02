import { describe, expect, test } from 'vitest';
import { generateLongApp } from '../src/gen/long-app.js';
import { cite } from '../src/gen/long.js';
import { generateLongEvent } from '../src/gen/long-event.js';
import type { Scenario, Step } from '../src/types.js';

// R-L11: one marker rule in both long generators: a fact's marker appears wherever its content is
// restated after the fact is introduced (replies, messages, deliverables and their summaries,
// decisions and failures, replanned briefs, contract specs, review notes and conventions).
// The phrases below identify restatements; a text unit containing one must also carry the marker.
// A unit is a paragraph of one such text. Units already present at or before the fact's step (for
// example a carried-over contract spec or an earlier deliverable paragraph) are not new restatements.

const LONG_APP: Record<string, string[]> = {
  'conv-given-when-then': ['Given/When/Then'],
  'conv-cursor-pagination': ['ursor pagination', 'cursor-based'],
  'conv-iso8601-utc': ['ISO 8601', 'UTC timestamps'],
  'conv-wcag-aa-contrast': ['WCAG'],
  'conv-no-pii-in-events': ['salted hash', 'personal data from the event'],
  'contract-error-envelope': ['requestId', 'server message and retry'],
  'conv-rate-limits-documented': ['rate limits', 'per minute per IP'],
  'conv-idempotency-key': ['Idempotency-Key', 'dempotency keys'],
  'change-household-6': ['up to 6 members'],
  'contract-invite-link-72h': ['72 hours'],
  'fail-websocket-fanout': ['ebsocket'],
  'fail-stripe-in-webview': ['webview'],
  'change-store-billing': ['App Store or Google Play', 'App Store and Google Play', 'sells nothing', 'Stripe checkout'],
  'contract-receipt-post': ['/v1/billing/receipts'],
  'conv-restore-path': ['estore purchases', 'restores on both stores', 'restoring purchases'],
  'change-offline-list': ['fully offline', 'works offline', 'dashboards are out of scope', 'dashboards dropped'],
  'contract-sync-cursor': ['stored cursor'],
  'fail-full-list-resync': ['ull list download'],
  'conv-delete-wins': ['delete-versus-edit', 'another member deleted'],
  'conv-story-and-build-in-reports': ['story ids', ' / build '],
  'change-eu-first': ['eu-west-1', 'EU launch'],
  'contract-export-zip-30d': ['ZIP of JSON'],
};

const LONG_EVENT: Record<string, string[]> = {
  'conv-prices-incl-vat': ['21% VAT', '21% Dutch VAT'],
  'conv-step-free-access': ['step-free', 'quiet room'],
  'change-capacity-1000': ['1,000 attendees', 'three tracks', 'three-track', 'three step-free'],
  'contract-room-capacities': ['720 seats', '1 Gbit'],
  'fail-open-ticket-link': ['resale bot', 'named tickets', 'invitation round', 'invitation from the waiting list'],
  'contract-badge-csv': ['UTF-8 CSV', 'final export', 'badge export'],
  'conv-signed-confirmation': ['who have signed', 'signed speakers'],
  'conv-no-paid-talks': ['buy a talk', 'contains a talk', 'selected like talks', 'instead of talks'],
  'conv-sponsor-opt-in-only': ['opt-in', 'opted in'],
  'conv-times-24h': ['24-hour'],
  'fail-venue-wifi-stream': ['Wi-Fi', 'wired stage uplink'],
  'conv-human-captions': ['human captioner'],
  'fail-auto-captions': ['utomatic captions', 'automatic speech'],
  'change-workshop-day': ['workshop day', 'workshop add-on', 'on 8 September'],
  'contract-workshop-seats-40': ['40 seats', 'stops at 40'],
  'conv-setup-guide-7d': ['setup guide'],
  'conv-run-sheet-owner': ['owner and a fallback', 'owners and fallbacks'],
  'change-no-livestream': ['livestream', 'record every talk', 'publish every talk'],
  'contract-video-7d': ['within 7 days', 'S-nn Speaker'],
  'conv-recording-release': ['recording release', 'release check', 'signed-release'],
  'change-green-event': ['700 km', 'egetarian by default', 'egetarian-by-default', 'green event', 'plastic swag', 'printed programme', 'reusable'],
  'contract-travel-log': ['travel log', 'booking reference'],
};

const leaves = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(leaves) : typeof v === 'object' && v !== null ? Object.values(v).flatMap(leaves) : [];

/** Team-facing texts of a step (private notes and lookups excluded), split into paragraphs. */
function units(step: Step): string[] {
  let texts: string[];
  switch (step.kind) {
    case 'human':
      texts = [step.text];
      break;
    case 'work':
      texts = [
        step.reply,
        ...(step.ops ?? []).filter(o => !['updateNotes', 'getBoardItem', 'searchLedger'].includes(o.name)).flatMap(o => {
          // Ids and enum values are not prose; the deliverable's workstream id and the message act are skipped.
          const { workstreamId: _w, act: _a, mentions: _m, affects: _f, ...rest } = o.args as Record<string, unknown>;
          return leaves(rest);
        }),
      ];
      break;
    case 'review':
      texts = [step.notes, ...(step.conventions ?? [])];
      break;
    case 'replan':
      texts = [...step.plan.workstreams.map(w => w.brief), ...step.plan.contracts.map(c => c.spec ?? '')];
      break;
  }
  return texts.flatMap(t => t.split('\n\n'));
}

/** Restatements (step, fact, text) after a fact's step that contain one of its phrases but not its marker. */
function unmarked(s: Scenario, phrases: Record<string, string[]>): string[] {
  const out: string[] = [];
  const initial = units({ kind: 'replan', plan: s.plan });
  const perStep = s.steps.map(units);
  for (const f of s.facts ?? []) {
    const ps = phrases[f.id];
    if (!ps) continue;
    const seen = new Set(initial);
    perStep.forEach((us, i) => {
      for (const u of us) {
        const fresh = !seen.has(u);
        seen.add(u);
        if (i <= f.step || !fresh || !ps.some(p => u.includes(p)) || u.includes(f.marker)) continue;
        out.push(`step ${i} ${f.id}: ${u.slice(0, 120)}`);
      }
    });
  }
  return out;
}

describe.each([
  { id: 'long-app', generate: generateLongApp, phrases: LONG_APP },
  { id: 'long-event', generate: generateLongEvent, phrases: LONG_EVENT },
])('$id restatements carry markers (R-L11)', ({ generate, phrases }) => {
  test('every fact has a phrase list', () => {
    expect((generate().facts ?? []).map(f => f.id).filter(id => !(id in phrases))).toEqual([]);
  });

  test('every later text that restates a fact carries its marker', () => {
    expect(unmarked(generate(), phrases)).toEqual([]);
  });
});

describe('cite (R-L11 helper)', () => {
  const facts = [{ marker: 'CHANGE-X', phrases: ['up to 6'] }, { marker: 'CONV-Y', phrases: ['cursor'] }];
  test('cites per paragraph, before closing punctuation, only what is restated and not yet marked', () => {
    expect(cite('Households of up to 6.\n\nNothing here\n\nA cursor and up to 6 people?', facts)).toBe(
      'Households of up to 6 (CHANGE-X).\n\nNothing here\n\nA cursor and up to 6 people (CHANGE-X, CONV-Y)?',
    );
    expect(cite('Already up to 6 (CHANGE-X)', facts)).toBe('Already up to 6 (CHANGE-X)');
    expect(cite('no punctuation cursor', facts)).toBe('no punctuation cursor (CONV-Y)');
  });
});
