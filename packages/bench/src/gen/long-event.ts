// long-event (spec §3): Harbour.dev 2027, a two-day developer conference in Rotterdam, prepared by six
// bots. Four requirement changes (1,000 attendees, a workshop day, no livestream, green event rules)
// each lead to a replan; the first comes early, before the agenda exists, and the third removes a
// workstream that was still in review. Reviews fail on the venue, tickets, speakers, sponsors, the
// agenda, promotion, the stream, logistics, workshops, recordings and the grant report and add
// conventions; bots ask each other questions. Deliverables grow version by version: each new version
// keeps the earlier text and adds what changed.
import type { PlanInput } from '@context-continue/core';
import type { Scenario } from '../types.js';
import { LongScenarioBuilder, op, rotate, type Restatements } from './long.js';

type Ws = PlanInput['workstreams'][number];
type Contract = PlanInput['contracts'][number];

const W = {
  venue: {
    id: 'venue',
    title: 'Venue and floor plan',
    brief: 'Book a venue in Rotterdam for 600 attendees on 9 and 10 September 2027 with a main hall, a second talk room and an expo area, and draw the floor plan.',
    owner: 'venue',
    dependsOn: [],
  },
  speakers: {
    id: 'speakers',
    title: 'Call for papers and speakers',
    brief: 'Run the call for papers, select about 30 talks with the programme committee, confirm the speakers and book their travel and hotels.',
    owner: 'program',
    dependsOn: [],
  },
  agenda: {
    id: 'agenda',
    title: 'Conference agenda',
    brief: 'Turn the selected talks into a two-track agenda for both days, with keynotes, breaks and room assignments.',
    owner: 'program',
    dependsOn: ['speakers', 'venue'],
  },
  sponsors: {
    id: 'sponsors',
    title: 'Sponsorship',
    brief: 'Design the sponsor packages, sell them to reach EUR 150,000 including VAT, and assign the expo booths.',
    owner: 'partners',
    dependsOn: ['venue'],
  },
  registration: {
    id: 'registration',
    title: 'Ticketing and registration',
    brief: 'Set up the ticket types, prices and registration form, run the ticket sales and keep the attendee list for badges and catering.',
    owner: 'marketing',
    dependsOn: [],
  },
  promotion: {
    id: 'promotion',
    title: 'Promotion',
    brief: 'Run the website, the announcement calendar, the newsletter and the social posts that sell the tickets.',
    owner: 'marketing',
    dependsOn: ['speakers'],
  },
  logistics: {
    id: 'logistics',
    title: 'On-site logistics',
    brief: 'Arrange catering, badges, signage, the cloakroom, volunteers and the run sheet for both days.',
    owner: 'venue',
    dependsOn: ['venue', 'registration'],
  },
  livestream: {
    id: 'livestream',
    title: 'Stage AV and livestream',
    brief: 'Provide stage sound, projection and lighting in every talk room and livestream the main hall on both days.',
    owner: 'production',
    dependsOn: ['venue', 'agenda'],
  },
} satisfies Record<string, Ws>;

const C: Record<string, Contract> = {
  speakersPromotion: {
    id: 'c-speakers-promotion',
    from: 'speakers',
    to: 'promotion',
    spec: 'Speaker name, job title, photo and abstract are handed over per talk, with the talk id T-nn the programme committee assigned.',
  },
  agendaStream: {
    id: 'c-agenda-livestream',
    from: 'agenda',
    to: 'livestream',
    spec: 'Each session has a session id S-nn, a room and a start and end time; the stream schedule and the lower thirds use the same ids.',
  },
  registrationLogistics: {
    id: 'c-registration-logistics',
    from: 'registration',
    to: 'logistics',
    spec: 'A weekly attendee export for badges and catering numbers, and a final one three days before the event.',
  },
  venueSponsors: {
    id: 'c-venue-sponsors',
    from: 'venue',
    to: 'sponsors',
    spec: 'An expo floor plan with numbered booth positions, booth sizes and power points.',
  },
};

/** The rooms contract; after the livestream is dropped the same spec points at the recordings. */
const ROOMS_SPEC =
  'Three talk rooms: Main hall 720 seats, Harbour room 180 seats, Quay room 150 seats, all step-free; each has a wired 1 Gbit uplink at the stage and its own power circuit for AV (CONTRACT-ROOM-CAPACITIES).';

const EMPLOYEES: Scenario['employees'] = [
  { botId: 'producer', persona: 'Event producer who splits the work, reviews every deliverable and keeps the plan and the budget consistent with what the owner wants.', skills: ['planning', 'review', 'budgeting'] },
  { botId: 'venue', persona: 'Venue and logistics manager who books venues and rooms, draws floor plans and runs catering, badges, volunteers and the run sheet.', skills: ['venue contracts', 'floor plans', 'catering', 'accessibility'] },
  { botId: 'program', persona: 'Programme chair who runs the call for papers, builds the agenda, looks after speakers and trainers and books their travel.', skills: ['call for papers', 'agenda design', 'speaker care'] },
  { botId: 'partners', persona: 'Sponsorship manager who designs and sells sponsor packages and runs the expo floor.', skills: ['sponsor sales', 'contracts', 'expo planning'] },
  { botId: 'marketing', persona: 'Marketing and ticketing lead who runs ticket sales, the registration form, the website, the newsletter and social media.', skills: ['ticketing', 'web content', 'newsletters', 'social media'] },
  { botId: 'production', persona: 'AV and broadcast producer who runs stage sound, projection, captions, streaming and recordings.', skills: ['stage AV', 'streaming', 'video editing', 'captioning'] },
];

/** R-L11: phrases that restate each fact; the builder cites the fact's marker wherever they appear later. */
const RESTATEMENTS: Restatements = {
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

/** Routine progress replies, rotated so consecutive updates do not read the same. */
const PROGRESS: ((done: string, next: string) => string)[] = [
  (d, n) => `Finished ${d}. Moving on to ${n}.`,
  (d, n) => `Update: ${d} is done and confirmed in writing. Next is ${n}.`,
  (d, n) => `${d.charAt(0).toUpperCase()}${d.slice(1)}: done. I am now on ${n}.`,
  (d, n) => `Closed out ${d} today; ${n} comes next.`,
];

export function generateLongEvent(): Scenario {
  const b = new LongScenarioBuilder({
    id: 'long-event',
    goal: 'Organise Harbour.dev 2027, a two-day developer conference in Rotterdam on 9 and 10 September 2027.',
    constraints: [
      'Ticket and sponsor income must cover the whole budget of EUR 420,000.',
      'Every part of the event is accessible to attendees with disabilities.',
      'Everything attendees see is in English and every time is Rotterdam local time.',
    ],
    owner: 'mira',
    lead: 'producer',
    employees: EMPLOYEES,
    restatements: RESTATEMENTS,
    plan: {
      workstreams: [W.venue, W.speakers, W.agenda, W.sponsors, W.registration, W.promotion, W.logistics, W.livestream],
      contracts: [C.speakersPromotion!, C.agendaStream!, C.registrationLogistics!, C.venueSponsors!],
    },
  });

  let turn = 0;
  /** A routine progress step: a short reply and a private note of what is done and what is next. */
  const progress = (bot: string, ws: string, done: string, next: string) =>
    b.work(bot, ws, rotate(PROGRESS, turn++)(done, next), [op.notes(`${ws}: done ${done}; next ${next}.`)]);

  // -------------------------------------------------------------------------
  // Phase 1: venue, tickets and the call for papers
  // -------------------------------------------------------------------------
  b.human(
    'Hi team. We are organising Harbour.dev 2027, a two-day developer conference in Rotterdam on 9 and 10 September 2027, for about 600 people. Last year our meetup sold out in a week, so the venue and the ticket sale come first. @producer please get everyone started; tickets should be on sale by 1 March.',
    ['producer'],
  );
  b.work('venue', 'venue', 'Starting the venue search. Five Rotterdam venues can hold 600 for a conference; I am visiting the best three this week.', [
    op.board('venue'),
    op.notes('Venue shortlist: Kraanhal (Katendrecht), Lloyd Congress Centre, Fenixloods. Need a main hall for 600, a second room for 150+, 800 m2 of expo, free on 9-10 Sep 2027.', true),
  ]);
  b.work('program', 'speakers', 'Opened the call for papers today; it runs for six weeks.', [
    op.notes('CFP: open 15 Jan, close 26 Feb 2027; themes Web, Cloud and Ops, Data and AI; 30-minute talks and 10-minute lightning talks; five reviewers, blind review.', true),
    op.message('The call for papers is open until 26 February: 30-minute talks and 10-minute lightning talks in three themes (Web, Cloud and Ops, Data and AI). Please share it with your networks.', 'inform'),
  ]);
  b.ask('marketing', 'registration', 'partners', {
    reply: 'Drafting the ticket types and the public quota.',
    question: 'will sponsors get free tickets in their packages, and how many, so I can hold them back from the public sale?',
  });
  b.answer('partners', 'sponsors', 'marketing', 'Yes: Gold sponsors get 6 tickets, Silver 3 and Bronze 2. With the mix I am aiming for that is about 40 tickets, so hold back 45 to be safe.', [
    op.notes('sponsors: ticket allowance Gold 6, Silver 3, Bronze 2; about 40 in total; marketing holds back 45.'),
  ]);
  b.deliver('marketing', 'registration', {
    reply: 'First version of the ticket types and the registration form.',
    summary: 'Ticket types, prices, quotas and registration form fields',
    add: [
      'Ticket types: early bird EUR 249, regular EUR 349, late EUR 399 and student EUR 99 (student card checked at the door). Prices are shown without VAT. 45 tickets are held back for sponsors and 25 for speakers; 530 go on public sale.',
      'Registration form: name, email, company, job title, date of birth, home address, phone number, T-shirt size, dietary needs and access needs. Up to 10 tickets per order, paid by card or iDEAL.',
      'Sales calendar: early bird from 1 March until 300 are sold or 31 March, regular until 31 July, late until the event.',
    ],
  });
  b.review('registration', false, 'Two problems. Prices without VAT will surprise every buyer at checkout, and we ask for date of birth, home address and phone number although we use none of them. Show the real prices and cut the form down to what we need.', [
    'Every ticket and sponsor price we publish is in EUR including 21% Dutch VAT (CONV-PRICES-INCL-VAT).',
  ]);
  b.fact('conv-prices-incl-vat', 'CONV-PRICES-INCL-VAT', ['marketing', 'partners'], {
    question: 'What currency and tax treatment must every published ticket and sponsor price follow?',
    expect: ['21%'],
  });
  b.work('production', 'livestream', 'Getting quotes for stage AV and streaming while the venue is being chosen.', [
    op.notes('livestream: quotes from two AV firms; main hall with 3 cameras, stream 1080p to YouTube; second room with sound and slides only.'),
  ]);
  b.deliver('venue', 'venue', {
    reply: 'Visited three venues; submitting my recommendation and a first floor plan.',
    summary: 'Kraanhal recommended; main hall, mezzanine room and expo',
    add: [
      'Recommendation: Kraanhal in Katendrecht, a former harbour crane hall, free from 8 to 11 September 2027 for EUR 68,000 including build-up. The main hall seats 650 theatre style, the mezzanine room seats 160, and the ground floor has 900 m2 for the expo and catering.',
      'Floor plan: entrance and registration desks at the east door, expo booths along both long walls, catering in the middle, the main hall at the north end and the mezzanine room one flight of stairs above the entrance. Cloakroom for 600 coats next to registration.',
      'Also checked: Lloyd Congress Centre (EUR 92,000, expo on another floor) and Fenixloods (only free on 16 and 17 September).',
    ],
  });
  b.review('venue', false, 'The mezzanine room is only reachable by stairs, so a wheelchair user cannot get to half of the talks, and there is no quiet room. Kraanhal can stay if we find a step-free second room.', [
    'Every space attendees use (talk rooms, expo, catering, toilets, workshop rooms) is reachable step-free, and the event has a quiet room (CONV-STEP-FREE-ACCESS).',
  ]);
  b.fact('conv-step-free-access', 'CONV-STEP-FREE-ACCESS', ['venue', 'program', 'production'], {
    question: 'What must be true of every space attendees use, and what extra room must the event provide?',
    expect: ['step-free', 'quiet room'],
  });
  b.ask('program', 'speakers', 'venue', {
    reply: 'Halfway through the call for papers with 212 proposals.',
    question: 'can the second talk room move to the ground floor so it is step-free (CONV-STEP-FREE-ACCESS), and would it still seat 150? It decides how many talks I accept.',
  });
  b.answer('venue', 'venue', 'program', 'Yes: Kraanhal can split the ground floor with an acoustic wall; the east part seats 180 step-free (CONV-STEP-FREE-ACCESS) and the expo keeps 650 m2. I am getting the quote for the wall.', [
    op.notes('venue: ground-floor second room for 180 behind an acoustic wall; mezzanine dropped; quiet room in the old crane office next to the cloakroom.'),
  ]);
  b.deliver('marketing', 'registration', {
    reply: 'Prices now include VAT and the form only asks what we use.',
    summary: 'Prices including VAT, shorter form, 4 tickets per order',
    add: [
      'Revision after review: all prices include 21% VAT: early bird EUR 299, regular EUR 419, late EUR 479, student EUR 119. The form asks only for name, email, company, ticket type, dietary needs and access needs; date of birth, address, phone and T-shirt size are gone. Orders are limited to 4 tickets.',
    ],
  });
  b.review('registration', true, 'Approved. Early bird can open on 1 March.');
  b.work('partners', 'sponsors', 'Drafting the sponsor packages from last year\'s sponsor feedback.', [
    op.board('c-venue-sponsors'),
    op.notes('sponsors: three tiers (Gold, Silver, Bronze); booth sizes from the venue floor plan; prices including VAT; target EUR 150,000.'),
  ]);
  b.deliver('venue', 'venue', {
    reply: 'Revised the venue plan: a step-free ground-floor room and a quiet room.',
    summary: 'Step-free second room on the ground floor; quiet room',
    add: [
      'Revision after review: the second talk room moves to the ground floor, split from the expo by an acoustic wall (EUR 6,500); it seats 180 and is step-free. The mezzanine is no longer used. The quiet room is the old crane office next to the cloakroom, step-free, with dimmed light and 12 seats. All toilets are on the ground floor, two of them accessible.',
    ],
  });
  b.review('venue', true, 'Approved. Please sign the Kraanhal contract.');
  b.work('venue', 'venue', 'Signing the venue contract.', [
    op.decide(
      'Book Kraanhal from 8 to 11 September 2027 (build-up on the 8th, teardown on the 11th) with the acoustic wall.',
      'It is the only shortlisted venue with the expo, catering and two step-free talk rooms on one floor, and it costs EUR 17,500 less than the alternative.',
      ['Lloyd Congress Centre'],
      ['venue'],
    ),
    op.notes('venue: contract signed, deposit EUR 20,400 paid; free cancellation until 1 May.'),
  ]);
  b.ask('program', 'speakers', 'production', {
    reply: 'Writing the speaker agreement.',
    question: 'what goes in the technical rider for speakers: what can they plug into, and do you want the slides in advance?',
  });
  b.answer('production', 'livestream', 'program', 'Every lectern has HDMI and USB-C, a 1920x1080 16:9 screen, a clicker and a confidence monitor. Ask for slides as PDF or Keynote by 1 September so we can test them; speakers may still bring their own laptop.');
  b.work('marketing', 'registration', 'Early bird opened this morning: 140 tickets sold in the first hour.', [
    op.message('Early bird is live at EUR 299 including VAT; 140 tickets sold in the first hour.', 'inform'),
    op.notes('registration: early bird live 1 March; 140 sold in hour one; waiting list form ready in case it sells out.'),
  ]);
  progress('production', 'livestream', 'the site visit at Kraanhal with the AV firm', 'the cable runs for the second talk room');

  // -------------------------------------------------------------------------
  // Change 1 (early): 1,000 attendees and three tracks
  // -------------------------------------------------------------------------
  b.human(
    'Change of plan (CHANGE-CAPACITY-1000): early bird sold out in two days and 1,700 people are on the waiting list. We plan for 1,000 attendees instead of 600, with three talk tracks instead of two. The budget grows to EUR 560,000 and ticket and sponsor income must still cover it. @venue can Kraanhal take 1,000?',
    ['venue'],
  );
  b.fact('change-capacity-1000', 'CHANGE-CAPACITY-1000', ['*'], {
    question: 'How many attendees and how many talk tracks are we planning for now? Give only the current value.',
    expect: ['1,000', '1000', 'three talk tracks', 'three tracks', '3 tracks'],
    reject: ['600 people', '600 attendees', 'two talk tracks', 'two tracks'],
  });
  b.replan({
    workstreams: [
      { ...W.venue, brief: 'Host 1,000 attendees at Kraanhal on 9 and 10 September 2027: three step-free talk rooms, the expo area and the floor plan.' },
      { ...W.speakers, brief: 'Run the call for papers, select about 45 talks for three tracks with the programme committee, confirm the speakers and book their travel and hotels.' },
      { ...W.agenda, brief: 'Turn the selected talks into a three-track agenda for both days, with keynotes, breaks and room assignments.' },
      { ...W.sponsors, brief: 'Design the sponsor packages, sell them to reach EUR 220,000 including VAT, and assign the expo booths.' },
      { ...W.registration, brief: 'Set up the ticket types, prices and registration form, run the ticket sales for 1,000 attendees and keep the attendee list for badges and catering.' },
      W.promotion,
      W.logistics,
      { ...W.livestream, brief: 'Provide stage sound, projection and lighting in all three talk rooms and livestream the main hall on both days.' },
    ],
    contracts: [
      C.speakersPromotion!,
      C.agendaStream!,
      C.registrationLogistics!,
      C.venueSponsors!,
      { id: 'c-venue-livestream', from: 'venue', to: 'livestream', spec: ROOMS_SPEC },
    ],
  });
  b.fact('contract-room-capacities', 'CONTRACT-ROOM-CAPACITIES', ['production', 'program', 'venue'], {
    question: 'What are the seat capacities of the Main hall, the Harbour room and the Quay room?',
    expect: ['720'],
  });
  b.work('venue', 'venue', '@mira Kraanhal can take 1,000 (CHANGE-CAPACITY-1000): the main hall goes to 720 seats once the expo moves to the south end, and a heated, step-free pavilion on the quay adds the Quay room with 150 seats; with the Harbour room at 180 that matches CONTRACT-ROOM-CAPACITIES. I am getting the revised quote.', [
    op.notes('venue: main hall 720; Harbour room 180 (ground floor); Quay room pavilion 150 with a level ramp; uplinks and AV power per room as in CONTRACT-ROOM-CAPACITIES.'),
  ]);
  b.work('marketing', 'registration', 'The second batch of tickets was hit by resale bots; recording what happened before the next release (FAIL-OPEN-TICKET-LINK).', [
    op.failure(
      'Releasing the second batch of 400 tickets through a public link with only a per-order limit (FAIL-OPEN-TICKET-LINK).',
      'Resale bots bought 180 tickets in four minutes with throwaway accounts and listed them at up to EUR 900; the limit of 4 per order did not stop them. Those orders were cancelled and refunded.',
      ['registration'],
    ),
    op.message('Heads-up (FAIL-OPEN-TICKET-LINK): resale bots bought 180 tickets in four minutes from the public link for the second batch. I cancelled those orders; from now on tickets are named and go out by invitation from the waiting list.', 'inform'),
  ]);
  b.fact('fail-open-ticket-link', 'FAIL-OPEN-TICKET-LINK', ['marketing', 'venue'], {
    question: 'Which way of releasing the second batch of tickets failed against resale bots?',
    expect: ['public link', 'per order', 'open link'],
  });
  b.deliver('venue', 'venue', {
    reply: 'The venue plan now holds 1,000 attendees in three step-free rooms.',
    summary: 'Three step-free talk rooms for 1,000 attendees',
    add: [
      'Capacity for 1,000 attendees (CHANGE-CAPACITY-1000): the main hall seats 720 once the expo moves to the south end, the Harbour room on the ground floor seats 180, and the new Quay room is a heated pavilion on the quay with 150 seats, reached by a level ramp. Each room has a wired 1 Gbit uplink at the stage and its own AV power circuit, as CONTRACT-ROOM-CAPACITIES says. The venue now costs EUR 81,000 plus EUR 14,000 for the pavilion.',
    ],
  });
  b.review('venue', true, 'Approved.');
  progress('program', 'speakers', 'a second committee round to fill three tracks instead of two', 'the acceptance emails');
  b.ask('marketing', 'registration', 'venue', {
    reply: 'Moving to named tickets after the resale bots (FAIL-OPEN-TICKET-LINK).',
    question: 'tickets are named now because of the resale bots (FAIL-OPEN-TICKET-LINK); what exactly do you need in the attendee export to print badges and check names at the door?',
  });
  b.answer('venue', 'logistics', 'marketing', 'A UTF-8 CSV with the columns ticket_id, first_name, last_name, company, ticket_type, dietary, access_needs, sorted by last name (CONTRACT-BADGE-CSV). Weekly from 1 July and a final export on 6 September at 12:00. Names must match the ticket because we check ID at the door.');
  b.fact('contract-badge-csv', 'CONTRACT-BADGE-CSV', ['venue', 'marketing'], {
    question: 'Which columns does the badge export for the venue contain?',
    expect: ['ticket_id', 'access_needs'],
  });

  // -------------------------------------------------------------------------
  // Phase 2: speakers, sponsors, agenda and promotion
  // -------------------------------------------------------------------------
  b.deliver('program', 'speakers', {
    reply: 'The call for papers has closed; here are the results.',
    summary: 'CFP results: 45 talks for three tracks, keynotes, travel',
    add: [
      'Call for papers: 412 proposals from 31 countries, reviewed blind by five committee members. Selected 38 talks and 7 lightning talks for three tracks; 15 talks are on the waiting list.',
      'Speakers: 33 have signed the speaker agreement and 12 have accepted by email but not signed yet. Keynotes: Amira Haddad on browser engines on day 1 and Tomasz Wrona on platform engineering on day 2, both signed.',
      'Hand-over: the full list of 45 speakers goes to marketing today so the line-up can be published next week.',
      'Travel: speakers from abroad get economy travel and two nights at Hotel New York, booked by us.',
    ],
  });
  b.review('speakers', false, 'Twelve of these speakers have not signed, and the list is about to go public. If one of them drops out we will have announced a talk that does not happen. Hand over only signed speakers.', [
    'A speaker is named publicly (website, newsletter, social posts, sponsor material) only after they have signed the speaker agreement (CONV-SIGNED-CONFIRMATION).',
  ]);
  b.fact('conv-signed-confirmation', 'CONV-SIGNED-CONFIRMATION', ['program', 'marketing'], {
    question: 'When may a speaker be named publicly?',
    expect: ['speaker agreement', 'signed the agreement', 'after signing'],
  });
  b.deliver('partners', 'sponsors', {
    reply: 'First version of the sponsor packages.',
    summary: 'Gold, Silver and Bronze packages; 28 expo booths',
    add: [
      'Packages, prices including VAT: Gold EUR 30,250 (4 available): 18 m2 booth, logo on the stage screens, a 30-minute talk in the main hall, the full attendee list after the event and 6 tickets. Silver EUR 14,520 (10): 9 m2 booth, a 10-minute lightning talk and 3 tickets. Bronze EUR 6,050 (14): logo on the website and the lanyards, 2 tickets.',
      'Expo: 28 booths on the south side of the ground floor, numbered E-01 to E-28 on the venue floor plan, with power at every booth.',
      'Pipeline: 3 Gold and 4 Silver sponsors have said yes in principle.',
    ],
  });
  b.review('sponsors', false, 'Two things we cannot sell. Talks are chosen by the programme committee, not bought; a paid talk in the main hall costs us the trust of the attendees. And we cannot hand over the attendee list, because people never agreed to that.', [
    'Sponsors never buy a talk, keynote or workshop; sponsored content goes in a clearly marked sponsor session in the Quay room at lunch (CONV-NO-PAID-TALKS).',
    'Attendee data reaches a sponsor only when the attendee opts in, by an unticked checkbox at checkout or a badge scan at the booth (CONV-SPONSOR-OPT-IN-ONLY).',
  ]);
  b.fact('conv-no-paid-talks', 'CONV-NO-PAID-TALKS', ['partners', 'program'], {
    question: 'Can sponsors buy a talk, and where does sponsored content go?',
    expect: ['Quay'],
  });
  b.fact('conv-sponsor-opt-in-only', 'CONV-SPONSOR-OPT-IN-ONLY', ['partners', 'marketing'], {
    question: 'Under what condition does attendee data reach a sponsor?',
    expect: ['opts in', 'opt in', 'opted in', 'unticked checkbox', 'badge scan', 'consent'],
  });
  b.deliver('program', 'speakers', {
    reply: 'Marketing now gets only the signed speakers.',
    summary: 'Only signed speakers handed over; two replacements',
    add: [
      'Revision after review (CONV-SIGNED-CONFIRMATION): marketing gets the 36 signed speakers now; the other 9 are handed over one by one as their agreements are signed. Two unsigned speakers have since withdrawn and were replaced from the waiting list.',
    ],
  });
  b.review('speakers', true, 'Approved.');
  b.work('marketing', 'promotion', 'Announced the two keynotes; both have signed (CONV-SIGNED-CONFIRMATION).', [
    op.message('Keynotes announced today: Amira Haddad on browser engines and Tomasz Wrona on platform engineering, both signed (CONV-SIGNED-CONFIRMATION). The full line-up follows on 15 May.', 'inform'),
  ]);
  b.ask('partners', 'sponsors', 'marketing', {
    reply: 'Reworking the sponsor packages without the attendee list (CONV-SPONSOR-OPT-IN-ONLY).',
    question: 'can the checkout get the opt-in checkbox for Gold sponsors that CONV-SPONSOR-OPT-IN-ONLY needs, and can you send me the opt-in counts every week?',
  });
  b.answer('marketing', 'registration', 'partners', 'Yes: one unticked checkbox "Share my name, company and email with the Gold sponsors" (CONV-SPONSOR-OPT-IN-ONLY), and the weekly counts go in the sponsor report. Badge scans at the booth are the other route; the scanner app shows the attendee what is shared.');
  b.deliver('partners', 'sponsors', {
    reply: 'Revised the packages: no paid talks and no attendee list.',
    summary: 'Sponsor session instead of talks; opt-in data only',
    add: [
      'Revision after review: no package contains a talk (CONV-NO-PAID-TALKS). Gold gets a 20-minute slot in the sponsor session in the Quay room at lunch, marked as sponsored in the agenda, and a 24 m2 booth, for EUR 27,830 including VAT. Attendee data only comes from the opt-in checkbox at checkout and from badge scans at the booth (CONV-SPONSOR-OPT-IN-ONLY).',
    ],
  });
  b.review('sponsors', true, 'Approved.');
  progress('production', 'livestream', 'the AV quote comparison for three rooms', 'the camera plan for the main hall');
  b.work('program', 'agenda', 'Starting the agenda from the selected talks and the three rooms.', [
    op.board('c-agenda-livestream'),
    op.notes('agenda: Web in the main hall, Cloud and Ops in the Harbour room, Data and AI in the Quay room; keynotes in the main hall; sponsor session at lunch in the Quay room.'),
  ]);
  b.ask('program', 'agenda', 'venue', {
    reply: 'Laying out the breaks.',
    question: 'how long does the walk from the main hall to the Quay room take, and can 700 people get coffee in a 20-minute break?',
  });
  b.answer('venue', 'logistics', 'program', 'Four minutes at a slow pace over the ramp. Coffee for 700 in 20 minutes would need 14 serving points; with 30-minute breaks and a 75-minute lunch, 10 points are enough.');
  b.deliver('program', 'agenda', {
    reply: 'First version of the agenda.',
    summary: 'Three tracks on both days, keynotes, breaks and rooms',
    add: [
      'Day 1, 9 September: doors at 8am, keynote at 9:15 in the main hall, three tracks from 10:30 to 5:45 PM, lightning talks 4pm-4:45pm in the Harbour room, party from 7 pm on the quay.',
      'Day 2, 10 September: keynote at 9.15, tracks until 17.00, closing panel at 17.15 in the main hall.',
      'Tracks: Web in the main hall, Cloud and Ops in the Harbour room, Data and AI in the Quay room; 30-minute talks with 10-minute changeovers, 30-minute breaks and a 75-minute lunch; the sponsor session is in the Quay room at 12:45.',
    ],
  });
  b.review('agenda', false, 'The times mix 8am, 5:45 PM and 17.00, and the sessions have no ids, so the stream schedule, the signs and the website will never agree. Pick one format and give every session its id.', [
    'Every time we publish is 24-hour Rotterdam local time written HH:MM (09:15, 17:45), and every session carries its id S-nn wherever it appears (CONV-TIMES-24H).',
  ]);
  b.fact('conv-times-24h', 'CONV-TIMES-24H', ['program', 'marketing', 'production', 'venue'], {
    question: 'What time format must every published time use?',
    expect: ['24-hour', 'HH:MM', '24h'],
  });
  b.work('marketing', 'promotion', 'Building the speakers page from the signed speakers.', [
    op.board('c-speakers-promotion'),
    op.notes('promotion: speakers page from signed speakers only; agenda page waits for the session ids; newsletter every two weeks.'),
  ]);
  b.deliver('program', 'agenda', {
    reply: 'Rewrote the agenda in 24-hour time with session ids.',
    summary: '24-hour times and session ids S-01 to S-52',
    add: [
      'Revision after review (CONV-TIMES-24H): all times are 24-hour local time and every session has an id. Day 1: doors 08:00, S-01 keynote 09:15-10:00 in the main hall, talks S-02 to S-25 from 10:30 to 17:45, lightning talks S-26 16:00-16:45 in the Harbour room, party from 19:00. Day 2: S-27 keynote 09:15, talks S-28 to S-50 until 17:00, S-51 closing panel 17:15-18:00 in the main hall. Sponsor session S-52 in the Quay room at 12:45 on both days, marked as sponsored.',
    ],
  });
  b.review('agenda', true, 'Approved.');
  b.ask('marketing', 'promotion', 'program', {
    reply: 'Building the agenda page on the website.',
    question: 'can I get the agenda as a feed with the session ids, so the website never needs retyping?',
  });
  b.answer('program', 'agenda', 'marketing', 'Yes: the speaker portal exports JSON with id, title, speaker, room, start and end, times as HH:MM (CONV-TIMES-24H). It updates every hour.');
  b.ask('production', 'livestream', 'program', {
    reply: 'Preparing the stream schedule from the agenda.',
    question: 'do the speakers know the main hall is livestreamed, and can a speaker opt out of the stream?',
  });
  b.answer('program', 'speakers', 'production', 'The agreement says the main hall is streamed and a speaker can opt out in writing; so far two have, S-14 and S-37. I will send you the list by session id.');
  b.work('production', 'livestream', 'Tested streaming over the venue network during a busy event; it failed, recording it (FAIL-VENUE-WIFI-STREAM).', [
    op.failure(
      'Streaming the main hall over the venue Wi-Fi during a busy event (FAIL-VENUE-WIFI-STREAM).',
      'At a 500-person event in Kraanhal the shared Wi-Fi dropped our 8 Mbit test stream eleven times in an hour. The stream must use the wired stage uplink, with a 4G bonding unit as backup.',
      ['livestream'],
    ),
    op.message('Heads-up (FAIL-VENUE-WIFI-STREAM): the venue Wi-Fi dropped our test stream eleven times in an hour at a busy event. We stream over the wired stage uplink only, with a 4G backup.', 'inform'),
  ]);
  b.fact('fail-venue-wifi-stream', 'FAIL-VENUE-WIFI-STREAM', ['production', 'venue'], {
    question: 'How many times did the 8 Mbit test stream of the main hall drop in an hour?',
    expect: ['eleven', '11'],
  });
  b.work('venue', 'venue', 'Confirmed the wired stage uplinks with Kraanhal after the stream test (FAIL-VENUE-WIFI-STREAM).', [
    op.notes('venue: Kraanhal confirms a dedicated 1 Gbit wired line at each stage on a VLAN separate from the attendee Wi-Fi; EUR 1,800 for both days.'),
  ]);
  b.deliver('marketing', 'promotion', {
    reply: 'First version of the website and the announcement plan.',
    summary: 'Website, announcement calendar, newsletter and social',
    add: [
      'Website: harbourdev.nl with the speakers page (signed speakers only), the agenda by day and track, tickets, travel and accessibility pages. Announcements: keynotes on 10 April, full line-up on 15 May, agenda on 1 June, last-ticket push in August.',
      'Newsletter every two weeks to 9,400 subscribers; social posts three times a week on LinkedIn, Mastodon and Bluesky with speaker cards.',
      'Draft of the 15 May newsletter, "Meet the 45 speakers of Harbour.dev 2027", which includes the nine speakers still in contract talks so the line-up looks complete.',
    ],
  });
  b.review('promotion', false, 'The 15 May draft names nine speakers who have not signed, which breaks the convention we agreed (CONV-SIGNED-CONFIRMATION). Take them out and give people a way to follow new speaker announcements.');
  b.deliver('marketing', 'promotion', {
    reply: 'Took the unsigned speakers out of the newsletter.',
    summary: 'Only signed speakers; follow button for announcements',
    add: [
      'Revision after review: the 15 May newsletter names only the 39 speakers who have signed (CONV-SIGNED-CONFIRMATION), says "more speakers to be announced" and links a follow button; every new signature becomes its own speaker card on social.',
    ],
  });
  b.review('promotion', true, 'Approved.');
  progress('partners', 'sponsors', 'the contracts for 3 Gold and 6 Silver sponsors', 'the Bronze outreach to local companies');
  b.work('venue', 'logistics', 'Starting the on-site logistics.', [
    op.board('c-registration-logistics'),
    op.notes('logistics: caterer shortlist of three; badge printing on site; 40 volunteers in two shifts; signs with 24-hour times and session ids (CONV-TIMES-24H).'),
  ]);
  b.ask('venue', 'logistics', 'marketing', {
    reply: 'Briefing the caterer and the volunteer leads.',
    question: 'how many attendees have listed dietary or access needs so far?',
  });
  b.answer('marketing', 'registration', 'venue', 'Of 812 registrations: 214 vegetarian, 61 vegan, 38 gluten-free, 12 halal and 9 nut allergies; 17 wheelchair users, 6 need a sign-language interpreter and 23 asked for seats near the front. The weekly export follows CONTRACT-BADGE-CSV.');
  b.deliver('production', 'livestream', {
    reply: 'First version of the stage AV and livestream plan.',
    summary: 'AV in three rooms, main hall stream, crew and cost',
    add: [
      'Stage AV: every room has a lectern with HDMI and USB-C, two wireless microphones, a 1920x1080 projector or LED wall and a confidence monitor; the main hall gets three cameras and a vision mixer.',
      'Livestream: the main hall streams on both days to YouTube at 1080p over the wired stage uplink, with a 4G bonding unit as backup (see the recorded failure FAIL-VENUE-WIFI-STREAM). Captions are generated automatically by YouTube. Lower thirds show the session id and the speaker name from the agenda.',
      'Crew: 9 technicians a day; EUR 64,000 for both days.',
    ],
  });
  b.review('livestream', false, 'Automatic captions are not good enough for technical talks by speakers from 31 countries, and deaf attendees in the rooms need captions too, not only stream viewers. Show me captions that work.', [
    'Every talk shown on a screen or a stream has live captions written or corrected by a human captioner, shown in the room and on the stream (CONV-HUMAN-CAPTIONS).',
  ]);
  b.fact('conv-human-captions', 'CONV-HUMAN-CAPTIONS', ['production', 'program'], {
    question: 'Who must produce the live captions for talks on a screen or a stream?',
    expect: ['human captioner', 'human captioners', 'human'],
  });
  b.work('production', 'livestream', 'Measured automatic captions on last year\'s recordings; recording the result (FAIL-AUTO-CAPTIONS).', [
    op.failure(
      'Using automatic speech recognition captions for technical talks (FAIL-AUTO-CAPTIONS).',
      'On three of last year\'s talks automatic captions got 14% of the words wrong, mostly technical terms and names (Kubernetes became "cuban eighties"), and ran 6 seconds behind the speaker.',
      ['livestream'],
    ),
    op.message('Result (FAIL-AUTO-CAPTIONS): automatic captions got 14% of the words wrong on last year\'s talks and lagged 6 seconds. We book human captioners.', 'inform'),
  ]);
  b.fact('fail-auto-captions', 'FAIL-AUTO-CAPTIONS', ['production', 'program'], {
    question: 'What share of the words did the captions measured on three of last year\'s talks get wrong?',
    expect: ['14%', '14 percent'],
  });
  b.ask('production', 'livestream', 'program', {
    reply: 'Booking two human captioners per day (CONV-HUMAN-CAPTIONS).',
    question: 'can speakers send a list of the terms and names in their talks two weeks ahead? The human captioners (CONV-HUMAN-CAPTIONS) need it to prepare.',
  });
  b.answer('program', 'speakers', 'production', 'Yes: I am adding a glossary field to the speaker portal, due 26 August, and will send you the export by session id for the captioners (CONV-HUMAN-CAPTIONS).');
  b.human('@marketing a friend who uses a screen reader could not get through the ticket checkout: the date picker and the iDEAL button have no labels. Please fix that before the next batch.', ['marketing']);
  progress('marketing', 'registration', 'labels on the checkout date picker and the iDEAL button, tested with VoiceOver and NVDA', 'the waiting-list invitations for the next batch');

  // -------------------------------------------------------------------------
  // Change 2: a workshop day
  // -------------------------------------------------------------------------
  b.human(
    'New requirement (CHANGE-WORKSHOP-DAY): attendees and sponsors keep asking for hands-on sessions, so 8 September becomes a workshop day instead of a build-up day only. Eight workshops of 40 seats each, sold as an add-on to a conference ticket for EUR 145 including VAT. @program please own the workshops.',
    ['program'],
  );
  b.fact('change-workshop-day', 'CHANGE-WORKSHOP-DAY', ['*'], {
    question: 'What is 8 September now, and what does a workshop cost? Give only the current value.',
    expect: ['workshop day', 'EUR 145', '€145', '145 EUR'],
  });
  b.replan({
    workstreams: [
      { ...b.currentPlan.workstreams.find(w => w.id === 'venue')!, brief: 'Host 1,000 attendees at Kraanhal on 9 and 10 September 2027 (three step-free talk rooms, the expo area and the floor plan) and find eight step-free workshop rooms for 40 people on 8 September.' },
      ...b.currentPlan.workstreams.filter(w => ['speakers', 'agenda', 'sponsors'].includes(w.id)),
      { ...b.currentPlan.workstreams.find(w => w.id === 'registration')!, brief: 'Set up the ticket types, prices and registration form, run the ticket sales for 1,000 attendees and the workshop add-on, and keep the attendee list for badges and catering.' },
      ...b.currentPlan.workstreams.filter(w => ['promotion', 'logistics', 'livestream'].includes(w.id)),
      {
        id: 'workshops',
        title: 'Workshop day',
        brief: 'Run eight hands-on workshops of 40 seats on 8 September: choose the trainers and topics, assign the rooms and publish the setup guides.',
        owner: 'program',
        dependsOn: ['venue', 'speakers'],
      },
    ],
    contracts: [
      ...b.currentPlan.contracts,
      {
        id: 'c-workshops-registration',
        from: 'workshops',
        to: 'registration',
        spec: 'Each workshop W-1 to W-8 has 40 seats, a title, a level and prerequisites; registration sells it only as an add-on to a conference ticket, stops at 40 and keeps a waiting list (CONTRACT-WORKSHOP-SEATS-40).',
      },
    ],
  });
  b.fact('contract-workshop-seats-40', 'CONTRACT-WORKSHOP-SEATS-40', ['program', 'marketing'], {
    question: 'How many seats does each workshop have, and how is it sold?',
    expect: ['40 seats', 'add-on'],
  });
  b.work('program', 'workshops', 'Starting the workshop day: topics first, then trainers.', [
    op.board('c-workshops-registration'),
    op.notes('workshops: pick 8 topics from the workshop proposals in the call for papers; trainers paid EUR 1,200; 40 seats each (CONTRACT-WORKSHOP-SEATS-40).', true),
  ]);
  b.ask('venue', 'venue', 'program', {
    reply: 'Looking for rooms for the workshop day on 8 September (CHANGE-WORKSHOP-DAY).',
    question: 'do the workshops on the new workshop day (CHANGE-WORKSHOP-DAY) need power at every seat and a projector, and can they run in hotel meeting rooms?',
  });
  b.answer('program', 'workshops', 'venue', 'Yes to both: 40 laptops need a power strip per table and each room a projector; a wired network helps the two Kubernetes workshops. Hotel meeting rooms are fine if they are step-free (CONV-STEP-FREE-ACCESS).');
  b.deliver('venue', 'venue', {
    reply: 'Booked the workshop rooms for 8 September.',
    summary: 'Eight step-free workshop rooms for the workshop day',
    add: [
      'Workshop rooms (CHANGE-WORKSHOP-DAY): Hotel New York across the street has six meeting rooms for 40 with projectors, power at every table and step-free access by lift; the Harbour room and the Quay room at Kraanhal take the other two workshops, because build-up on the 8th only uses the main hall and the expo. The rooms cost EUR 9,600.',
    ],
  });
  b.review('venue', true, 'Approved.');
  b.deliver('marketing', 'registration', {
    reply: 'Added the workshop add-on and named tickets to the ticket shop.',
    summary: 'Workshop add-on, named tickets, invitation sales',
    add: [
      'Workshop add-on (CHANGE-WORKSHOP-DAY): EUR 145 including VAT, sold only with a conference ticket; each of W-1 to W-8 stops at 40 seats and has a waiting list, as CONTRACT-WORKSHOP-SEATS-40 says. Tickets are named and sold by invitation from the waiting list since the resale bots (FAIL-OPEN-TICKET-LINK); a name change is free until 1 September.',
    ],
  });
  b.review('registration', true, 'Approved.');
  b.ask('program', 'workshops', 'marketing', {
    reply: 'Choosing the workshop topics.',
    question: 'how many ticket holders said in the survey that they want a workshop, and which topics came first?',
  });
  b.answer('marketing', 'promotion', 'program', 'Of 640 answers, 410 want a workshop. Top topics: Kubernetes operators (188), web performance (151), Rust for backend services (120), evaluating LLM features (117) and accessibility testing (96).');
  b.deliver('program', 'workshops', {
    reply: 'First version of the workshop day.',
    summary: 'Eight workshops, trainers, rooms and lunch',
    add: [
      'Workshops on 8 September, 09:30-16:30, 40 seats each: W-1 Kubernetes operators, W-2 Web performance budgets, W-3 Rust for backend services, W-4 Evaluating LLM features, W-5 Accessibility testing with screen readers, W-6 Terraform at scale, W-7 Postgres query tuning, W-8 Design systems in practice. Trainers come from the call for papers and are paid EUR 1,200 each.',
      'Rooms: W-1 to W-6 at Hotel New York, W-7 and W-8 in the Harbour room and the Quay room. Lunch is served in both buildings at 12:30.',
    ],
  });
  b.review('workshops', false, 'People will arrive with laptops that cannot run the exercises; a Kubernetes workshop where half the room spends an hour installing tools is wasted. Every workshop needs prerequisites and a setup guide well before the day.', [
    'Every workshop publishes its level, prerequisites and a tested setup guide at least 7 days before the workshop, and the trainer answers setup questions until then (CONV-SETUP-GUIDE-7D).',
  ]);
  b.fact('conv-setup-guide-7d', 'CONV-SETUP-GUIDE-7D', ['program', 'marketing'], {
    question: 'How far ahead of a workshop must its setup guide be published?',
    expect: ['7 days', 'seven days', 'one week', 'a week'],
  });
  b.ask('partners', 'sponsors', 'program', {
    reply: 'Following up with the Gold sponsors.',
    question: 'two Gold sponsors want to run a workshop; can they take a slot on the workshop day?',
  });
  b.answer('program', 'workshops', 'partners', 'No: workshops are selected like talks (CONV-NO-PAID-TALKS). A sponsor engineer can apply as a trainer through the committee, and sponsors can present in their own sponsor session in the Quay room at lunch.');
  b.deliver('program', 'workshops', {
    reply: 'Added levels, prerequisites and setup guides.',
    summary: 'Setup guides published 7 days ahead; cloud sandboxes',
    add: [
      'Revision after review (CONV-SETUP-GUIDE-7D): each workshop page lists the level, the prerequisites and a setup guide the trainer tested on macOS, Windows and Linux; guides are published by 1 September and trainers answer questions in a shared channel until the day. W-1 and W-6 provide cloud sandboxes, so nothing heavy has to be installed.',
    ],
  });
  b.review('workshops', true, 'Approved.');
  b.work('marketing', 'registration', 'Opened the workshop add-on sale for ticket holders.', [
    op.message('The workshop add-on is on sale for ticket holders: EUR 145 including VAT, 40 seats per workshop with a waiting list (CONTRACT-WORKSHOP-SEATS-40); setup guides are linked from each workshop page.', 'inform'),
  ]);
  progress('marketing', 'promotion', 'the workshop pages with level, prerequisites and setup guide links', 'the August last-ticket push');
  b.deliver('production', 'livestream', {
    reply: 'Replaced automatic captions with human captioners.',
    summary: 'Human live captions in the rooms and on the stream',
    add: [
      'Revision after review (CONV-HUMAN-CAPTIONS): two human captioners per room and day write live captions from the speakers\' glossaries; the captions show on a screen beside each stage and on the stream. Automatic captions are not used (see the recorded failure FAIL-AUTO-CAPTIONS). Captioning costs EUR 11,200 for both days.',
    ],
  });
  b.review('livestream', false, 'The captioning is right, but stage AV, stream and captions now come to EUR 75,200 against EUR 52,000 in the budget. I have asked Mira whether we keep the stream; hold any bookings until she decides.');
  b.deliver('venue', 'logistics', {
    reply: 'First version of the on-site logistics.',
    summary: 'Catering, badges, cloakroom, volunteers and run sheet',
    add: [
      'Catering: Fair Food Rotterdam serves breakfast, two coffee breaks, lunch and the party buffet for 1,000 on both days at EUR 68 per person per day; the menus cover the dietary needs from registration.',
      'Badges: printed on 7 September from the final export (CONTRACT-BADGE-CSV); 10 check-in desks open at 07:30. Cloakroom for 900 coats. 40 volunteers in two shifts.',
      'Run sheet: build-up on 8 September from 07:00, doors on the 9th at 08:00, teardown on the 11th until 14:00; tasks listed by time.',
    ],
  });
  b.review('logistics', false, 'The run sheet lists tasks by time but not who does them. On the day nobody will know who opens the cloakroom or who calls the captioners when they are late.', [
    'Every run-sheet line names one owner and one fallback person with a phone number, with times as CONV-TIMES-24H says (CONV-RUN-SHEET-OWNER).',
  ]);
  b.fact('conv-run-sheet-owner', 'CONV-RUN-SHEET-OWNER', ['venue', 'production', 'program'], {
    question: 'What must every run-sheet line name?',
    expect: ['one owner', 'fallback', 'backup person'],
  });
  progress('venue', 'logistics', 'the badge printer rental (two printers, 600 badges an hour each)', 'the volunteer roster');
  b.ask('venue', 'logistics', 'production', {
    reply: 'Adding owners to the run sheet (CONV-RUN-SHEET-OWNER).',
    question: 'for the run sheet (CONV-RUN-SHEET-OWNER), who in your crew owns the stage changeovers in each room, and who is the fallback?',
  });
  b.answer('production', 'livestream', 'venue', 'For the run sheet (CONV-RUN-SHEET-OWNER): main hall Sanne, fallback Joris; Harbour room Pieter, fallback Anouk; Quay room Malik, fallback Sanne. Their phone numbers are in the crew sheet.');

  // -------------------------------------------------------------------------
  // Change 3: no livestream, recordings instead
  // -------------------------------------------------------------------------
  b.human(
    'Decision on the stream (CHANGE-NO-LIVESTREAM): the streaming sponsor has pulled out and we cannot carry EUR 75,000 of AV. We drop the livestream. Instead we record all three rooms and publish every talk within 7 days. Live captions stay in the rooms.',
  );
  b.fact('change-no-livestream', 'CHANGE-NO-LIVESTREAM', ['*'], {
    question: 'How do people who are not in the rooms get the talks now? Give only the current value.',
    expect: ['record all three rooms', 'all three rooms', 'recorded', 'recordings'],
  });
  b.replan({
    workstreams: [
      ...b.currentPlan.workstreams.filter(w => w.id !== 'livestream'),
      {
        id: 'recordings',
        title: 'Stage AV and recordings',
        brief: 'Provide stage sound, projection, lighting and live captions in all three talk rooms, record every talk and publish the edited videos within 7 days.',
        owner: 'production',
        dependsOn: ['venue', 'agenda'],
      },
    ],
    contracts: [
      ...b.currentPlan.contracts.filter(c => c.to !== 'livestream'),
      {
        id: 'c-agenda-recordings',
        from: 'agenda',
        to: 'recordings',
        spec: 'Each session has a session id S-nn, a room and a start and end time; video titles and the recording schedule use the same ids.',
      },
      { id: 'c-venue-recordings', from: 'venue', to: 'recordings', spec: ROOMS_SPEC },
      {
        id: 'c-recordings-promotion',
        from: 'recordings',
        to: 'promotion',
        spec: 'Every talk video is published on the Harbour.dev YouTube channel within 7 days of the talk, titled "S-nn Speaker: Title", with corrected captions; marketing gets the links in a CSV the same day (CONTRACT-VIDEO-7D).',
      },
    ],
  });
  b.fact('contract-video-7d', 'CONTRACT-VIDEO-7D', ['production', 'marketing'], {
    question: 'How soon must a talk video be published, and how is it titled?',
    expect: ['S-nn Speaker'],
  });
  b.work('production', 'recordings', 'Re-planning the AV for recordings instead of a stream.', [
    op.board('c-recordings-promotion'),
    op.notes('recordings: two cameras and the slide feed per room, recorded locally; editors on site; uploads over the wired stage uplink, never the venue Wi-Fi (FAIL-VENUE-WIFI-STREAM).'),
    op.decide(
      'Record every room with two cameras and the slide feed, and edit on site overnight.',
      'Editors who sat in the room cut faster than an outside post-production house, which keeps the 7-day promise of CONTRACT-VIDEO-7D.',
      ['Send all raw footage to an external post-production house'],
      ['recordings'],
    ),
  ]);
  b.ask('marketing', 'promotion', 'production', {
    reply: 'Planning the social posts for the event days.',
    question: 'can we get a 60-second highlight clip by the evening of each day?',
  });
  b.answer('production', 'recordings', 'marketing', 'Yes: one editor cuts a highlight clip from the main hall by 20:00 each day; the full talks follow within 7 days, as CONTRACT-VIDEO-7D says.');
  b.deliver('partners', 'sponsors', {
    reply: 'Sponsor status and the package change after the stream was dropped.',
    summary: 'EUR 248,000 sold; recordings package replaces the stream',
    add: [
      'Status: 4 Gold, 9 Silver and 12 Bronze sold, EUR 248,000 including VAT. The streaming package is cancelled now that the livestream is dropped (CHANGE-NO-LIVESTREAM); in its place a recordings package puts the sponsor logo on the 3-second intro of every published video. Booths E-01 to E-25 are assigned; E-26 to E-28 are kept for start-ups at EUR 1,210 including VAT.',
    ],
  });
  b.review('sponsors', true, 'Approved.');
  progress('program', 'speakers', 'the hotel bookings for 41 speakers at Hotel New York', 'the speakers\' travel bookings');
  b.deliver('production', 'recordings', {
    reply: 'First version of the AV and recording plan.',
    summary: 'Stage AV, live captions, two-camera recordings, 7-day publishing',
    add: [
      'Stage AV in all three rooms: a lectern with HDMI and USB-C, two wireless microphones, projection, a confidence monitor and live captions by human captioners on a screen beside each stage (CONV-HUMAN-CAPTIONS).',
      'Recordings: two cameras and the slide feed per room, recorded locally; editors on site cut each talk overnight with the corrected captions, titled "S-nn Speaker: Title", and publish on YouTube within 7 days (CONTRACT-VIDEO-7D), uploading over the wired stage uplink.',
      'Cost: EUR 46,500 for AV, recording and editing, plus EUR 11,200 for captioning.',
    ],
  });
  b.review('recordings', false, 'Do we have every speaker\'s permission to publish their talk? The speaker agreement covers a stream with an opt-out, not a video that stays online. Get a recording release from every speaker before anything is published.', [
    'No talk is recorded or published without a signed recording release from every speaker on stage; for a talk without one the cameras stay off (CONV-RECORDING-RELEASE).',
  ]);
  b.fact('conv-recording-release', 'CONV-RECORDING-RELEASE', ['program', 'production'], {
    question: 'What must a speaker sign before their talk may be recorded or published?',
    expect: ['recording release'],
  });
  b.ask('program', 'speakers', 'production', {
    reply: 'Preparing the recording release for the speakers (CONV-RECORDING-RELEASE).',
    question: 'what should the recording release (CONV-RECORDING-RELEASE) cover: recording, editing and YouTube only, or also clips for social?',
  });
  b.answer('production', 'recordings', 'program', 'The release (CONV-RECORDING-RELEASE) should cover recording, editing, publishing the full talk on YouTube under CC BY 4.0 and clips of up to 60 seconds for social. Speakers may ask for a video to be taken down later.');
  b.work('program', 'speakers', 'Sent the recording release (CONV-RECORDING-RELEASE) to every speaker and trainer through the speaker portal.', [
    op.message('Recording releases are out to all 45 speakers and 8 trainers (CONV-RECORDING-RELEASE); 31 signed on the first day. Production gets the list of session ids with a signed release every Friday.', 'inform'),
    op.notes('speakers: recording release sent; chase unsigned on Mondays; Friday list to production.'),
  ]);
  b.deliver('production', 'recordings', {
    reply: 'Added the recording release check.',
    summary: 'Release check before every talk',
    add: [
      'Revision after review (CONV-RECORDING-RELEASE): the stage manager checks the signed-release list before each talk; if a speaker has not signed, the cameras stay off and only the live captions run. Today 43 of 45 speakers have signed; the other two will not be recorded.',
    ],
  });
  b.review('recordings', true, 'Approved.');
  progress('production', 'recordings', 'the editing room at Kraanhal with three edit stations', 'the caption file workflow from captioner to video');
  b.deliver('venue', 'logistics', {
    reply: 'Added owners and fallbacks to the run sheet.',
    summary: 'Run sheet with an owner and a fallback on every line',
    add: [
      'Revision after review (CONV-RUN-SHEET-OWNER): every run-sheet line names an owner and a fallback with a phone number, in 24-hour time. For example: 07:00 venue doors, owner Ruud (fallback Ilse); 07:30 check-in desks, owner Ilse (fallback Kees); 08:45 captioners at the stages, owner Sanne (fallback Joris). The stream crew is off the sheet since the livestream was dropped (CHANGE-NO-LIVESTREAM), and the recording crew is on it.',
    ],
  });
  b.review('logistics', true, 'Approved.');
  b.human('Ticket sales passed 900 this week and the workshops are nearly full. Great work, everyone.');
  progress('marketing', 'registration', 'the third waiting-list invitation round (120 named tickets)', 'the switch to the late price on 1 August');
  b.ask('partners', 'sponsors', 'venue', {
    reply: 'Collecting the booth requirements from the Gold sponsors.',
    question: 'can the Gold booths get a wired network port and 32 A power? Two sponsors run live hardware demos.',
  });
  b.answer('venue', 'venue', 'partners', 'Booths E-01 to E-04 can get a wired port on the expo VLAN and 32 A power for EUR 450 each including VAT; tell me which ones by 1 August.');
  b.human('How are we tracking for September? I would like a short status from each of you by Friday.');
  // The reply is the message itself, so it is posted once (R-L14, R-L9).
  const status = (bot: string, ws: string, text: string) => {
    const message = `Status for the week: ${text}`;
    b.work(bot, ws, message, [op.message(message, 'inform')]);
  };
  status('venue', 'logistics', 'Kraanhal and the Hotel New York rooms are confirmed; catering and the run sheet are approved; badge printers and the volunteer briefing are next.');
  status('program', 'workshops', 'the agenda is final with 52 sessions; the workshops are published with setup guides; 43 of 45 recording releases are signed and travel is half booked.');
  status('partners', 'sponsors', 'EUR 248,000 sold against a target of EUR 220,000; booth power requests are with the venue; two start-up booths are still open.');
  status('marketing', 'promotion', '934 tickets and 287 workshop seats sold; the August push and the last speaker cards are scheduled.');
  status('production', 'recordings', 'AV, captioners and the recording crew are booked; the editing room at Kraanhal is reserved; the speaker glossaries are due 26 August.');

  // -------------------------------------------------------------------------
  // Change 4: the city's green event rules
  // -------------------------------------------------------------------------
  b.human(
    'One more change (CHANGE-GREEN-EVENT): the city of Rotterdam will fund EUR 40,000 if we follow its green event rules. Speakers who travel less than 700 km come by train instead of plane, catering is vegetarian by default with meat only on request, there is no printed programme and no plastic swag, and badges and lanyards are collected and reused. We report the results to the city after the event. @venue please own that report.',
    ['venue'],
  );
  b.fact('change-green-event', 'CHANGE-GREEN-EVENT', ['*'], {
    question: 'Below what travel distance must speakers come by train? Give only the current value.',
    expect: ['700 km', '700km'],
  });
  b.replan({
    workstreams: [
      ...b.currentPlan.workstreams.filter(w => w.id === 'venue'),
      { ...b.currentPlan.workstreams.find(w => w.id === 'speakers')!, brief: 'Run the call for papers, select about 45 talks for three tracks with the programme committee, confirm the speakers and book their travel (by train for trips under 700 km) and hotels.' },
      ...b.currentPlan.workstreams.filter(w => ['agenda', 'sponsors', 'registration', 'promotion'].includes(w.id)),
      { ...b.currentPlan.workstreams.find(w => w.id === 'logistics')!, brief: 'Arrange vegetarian-by-default catering, reusable badges, signage, the cloakroom, volunteers and the run sheet for all three days, with no printed programme or plastic swag.' },
      ...b.currentPlan.workstreams.filter(w => ['workshops', 'recordings'].includes(w.id)),
      {
        id: 'sustainability',
        title: 'Green event report',
        brief: 'Meet the city of Rotterdam green event rules and write the report for the grant: travel, catering, waste and energy, with numbers against a usual event of this size.',
        owner: 'venue',
        dependsOn: ['logistics'],
      },
    ],
    contracts: [
      ...b.currentPlan.contracts,
      {
        id: 'c-speakers-sustainability',
        from: 'speakers',
        to: 'sustainability',
        spec: 'Per speaker and trainer: origin city, travel mode, distance in km and the booking reference; trips under 700 km are by train unless the speaker has a documented reason (CONTRACT-TRAVEL-LOG).',
      },
    ],
  });
  b.fact('contract-travel-log', 'CONTRACT-TRAVEL-LOG', ['program', 'venue'], {
    question: 'Which details must be logged per speaker trip?',
    expect: ['travel mode', 'booking reference', 'booking ref', 'mode of travel'],
  });
  b.ask('program', 'speakers', 'venue', {
    reply: 'Rebooking speaker travel for the green event rules (CHANGE-GREEN-EVENT).',
    question: 'does the travel log for the city report (CONTRACT-TRAVEL-LOG) need the return trips as well, and how do I log a speaker who combines the trip with other work in Europe?',
  });
  b.answer('venue', 'sustainability', 'program', 'Yes, log both directions. For a combined trip, log only the leg to and from Rotterdam from the previous and to the next city, with the booking reference, as CONTRACT-TRAVEL-LOG asks.');
  b.deliver('program', 'speakers', {
    reply: 'Rebooked speaker travel under the green event rules.',
    summary: 'Trains for trips under 700 km; travel log for the report',
    add: [
      'Travel (CHANGE-GREEN-EVENT): 19 speakers and trainers with trips under 700 km (London, Paris, Berlin, Brussels, Copenhagen, Zurich and others) are rebooked from flights to trains; two keep a flight for documented reasons (a wheelchair transfer that rail could not guarantee, and a connection from Singapore). The travel log per speaker follows CONTRACT-TRAVEL-LOG: origin, mode, km and booking reference, both directions.',
    ],
  });
  b.review('speakers', true, 'Approved.');
  b.work('partners', 'sponsors', 'Told the sponsors about the green event rules.', [
    op.message('Sponsors: under the city\'s green event rules (CHANGE-GREEN-EVENT) there is no plastic swag and no printed flyers at the booths. Digital give-aways and donations to the scholarship fund are welcome; booth material must be reusable.', 'inform'),
    op.notes('sponsors: swag rule sent to all 25 sponsors; two asked about tote bags (organic cotton allowed if reusable and no plastic print).'),
  ]);
  b.ask('venue', 'logistics', 'marketing', {
    reply: 'Re-ordering catering for vegetarian by default (CHANGE-GREEN-EVENT).',
    question: 'catering is vegetarian by default under the green event rules (CHANGE-GREEN-EVENT); can the registration form ask who wants meat, so the caterer can plan the on-request portions?',
  });
  b.answer('marketing', 'registration', 'venue', 'Yes: a new optional question "I would like a meat option" goes into the form today and into the badge export as a dietary value, so CONTRACT-BADGE-CSV does not change. Existing ticket holders get an email asking the same.');
  b.deliver('venue', 'logistics', {
    reply: 'Logistics changed for the green event rules.',
    summary: 'Vegetarian by default, reusable badges, no print',
    add: [
      'Green event rules (CHANGE-GREEN-EVENT): catering is vegetarian by default; meat only for the 96 attendees who asked for it. Badges are reusable sleeves with a printed insert, collected at the exit in return for a coffee voucher; lanyards are reused from last year. There is no printed programme: the agenda is on the website and on screens at every room. Water stations replace bottles.',
    ],
  });
  b.review('logistics', true, 'Approved.');
  b.deliver('marketing', 'promotion', {
    reply: 'Updated the website for the green event and the recordings.',
    summary: 'Travel by train page, no printed programme, video page',
    add: [
      'Green event (CHANGE-GREEN-EVENT): a travel page with train connections from 12 cities and the NS international discount code; the programme is online only, with a printable PDF for those who need one. Videos: a page per talk links its YouTube video once production sends the links, within 7 days of the talk as CONTRACT-VIDEO-7D says.',
    ],
  });
  b.review('promotion', true, 'Approved.');
  progress('production', 'recordings', 'the recording test in the Quay room pavilion with both cameras', 'the caption glossary import for the captioners');
  b.work('venue', 'sustainability', 'Starting the green event report from the travel log and the catering numbers.', [
    op.board('c-speakers-sustainability'),
    op.notes('sustainability: baseline = 2026 meetup scaled to 1,000; travel from CONTRACT-TRAVEL-LOG; catering kg CO2e per meal from the caterer; waste from the venue scales.', true),
  ]);
  b.deliver('venue', 'sustainability', {
    reply: 'First version of the green event report.',
    summary: 'Travel, catering, waste and energy totals',
    add: [
      'Travel: speakers and trainers travel 61,400 km, 71% by train; 2 flights within Europe. Attendees: 58% from the Netherlands, survey on travel mode after the event.',
      'Catering: 5,900 meals, 94% vegetarian. Waste: water stations instead of bottles, reusable badges and lanyards, no printed programme. Energy: Kraanhal runs on green power; the Quay room pavilion uses a battery unit instead of a diesel generator.',
    ],
  });
  b.review('sustainability', false, 'The city asks for savings against a usual event of this size, not only totals. Without a baseline the report does not show what the rules achieved.');
  b.ask('venue', 'sustainability', 'production', {
    reply: 'Adding energy numbers to the green event report (CHANGE-GREEN-EVENT).',
    question: 'how many kWh will the AV draw over the three days, and how much would the stream setup we dropped (CHANGE-NO-LIVESTREAM) have needed?',
  });
  b.answer('production', 'recordings', 'venue', 'About 2,900 kWh for AV, recording and captions over the three days; the stream setup dropped under CHANGE-NO-LIVESTREAM, with the vision mixer and the encoders, would have added about 700 kWh.');
  b.deliver('venue', 'sustainability', {
    reply: 'Added the baseline and the savings to the report.',
    summary: 'Savings against a usual event of 1,000 people',
    add: [
      'Baseline: the same event run the usual way (all speakers flying, mixed menu, printed programme, bottled water, diesel generator). Savings: speaker travel 18.4 t CO2e lower, catering 9.1 t lower, 1,000 printed programmes and about 6,000 bottles avoided, and 1,300 litres of diesel avoided. AV draws about 2,900 kWh, 700 kWh less than with the stream. Numbers are checked again with the final travel log (CONTRACT-TRAVEL-LOG) after the event.',
    ],
  });
  b.review('sustainability', true, 'Approved; this is what the city asked for.');
  progress('program', 'workshops', 'the trainer briefing for the workshop day', 'the room signs for Hotel New York');
  b.deliver('partners', 'sponsors', {
    reply: 'Final sponsor status and the booth set-up.',
    summary: 'All booths sold; power and network per booth',
    add: [
      'Final: the three start-up booths E-26 to E-28 are sold, so all 28 booths are taken and income is EUR 251,630 including VAT. Booths E-01 and E-03 get a wired port and 32 A power. Every sponsor has the green event rules (CHANGE-GREEN-EVENT) and the opt-in rule for attendee data (CONV-SPONSOR-OPT-IN-ONLY) in the exhibitor manual.',
    ],
  });
  b.review('sponsors', true, 'Approved.');

  // -------------------------------------------------------------------------
  // Final weeks
  // -------------------------------------------------------------------------
  b.ask('production', 'recordings', 'program', {
    reply: 'Preparing the stage schedule for the captioners.',
    question: 'are there any session swaps since the approved agenda? I need the final S-nn list to title the videos.',
  });
  b.answer('program', 'agenda', 'production', 'Two: S-19 (withdrawn) is replaced by a waiting-list talk on WebGPU in the same slot, and S-33 and S-34 swap rooms. I am updating the agenda today.');
  b.deliver('program', 'agenda', {
    reply: 'Final agenda with the last changes.',
    summary: 'S-19 replaced, S-33 and S-34 swapped, workshop day added',
    add: [
      'Final changes: S-19 is now "WebGPU in production" from the waiting list, 14:10-14:40 in the main hall; S-33 moves to the Harbour room and S-34 to the main hall on day 2. The workshop day W-1 to W-8 on 8 September is listed before day 1, 09:30-16:30. Every talk shows a captions icon; the two talks without a recording release show "not recorded".',
    ],
  });
  b.review('agenda', true, 'Approved; this is the final agenda.');
  b.deliver('production', 'recordings', {
    reply: 'Final AV and recording plan with the crew and the publishing schedule.',
    summary: 'Crew per room, captions glossary, publishing schedule',
    add: [
      'Final plan: each room has a stage manager who owns the release check, a camera operator and a captioner, as the run sheet names them. Glossaries from 41 of 45 speakers are loaded for the captioners. Publishing: day 1 talks go online by 14 September and day 2 talks by 15 September, with the links sent to marketing in a CSV the same day (CONTRACT-VIDEO-7D). The pavilion runs on a battery unit, 2,900 kWh in total.',
    ],
  });
  b.review('recordings', true, 'Approved.');
  b.deliver('marketing', 'registration', {
    reply: 'Final ticketing numbers and the last export.',
    summary: 'Sold out: 1,000 tickets, 320 workshop seats, final export',
    add: [
      'Sold out: 1,000 conference tickets (930 paid, 45 sponsor, 25 speaker) and all 320 workshop seats, with 214 on the workshop waiting lists. 312 attendees opted in to share their details with the Gold sponsors. The final badge export goes to venue on 6 September at 12:00 in the agreed format (CONTRACT-BADGE-CSV), including the meat-option answers.',
    ],
  });
  b.review('registration', true, 'Approved.');
  b.work('venue', 'logistics', 'Briefed the volunteers on the run sheet and the reusable badges.', [
    op.message('Volunteer briefing done: 40 volunteers, two shifts, every run-sheet line has an owner and a fallback (CONV-RUN-SHEET-OWNER); badge sleeves are collected at the exit for the green event report.', 'inform'),
  ]);
  b.human('Doors open in three days. Thank you all; this is the best-prepared event we have run.');

  return b.build();
}
