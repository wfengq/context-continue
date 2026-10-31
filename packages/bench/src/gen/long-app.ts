// long-app (spec §3): Larder, a meal-planning app with a shared grocery list, taken from requirements
// to an EU launch by eight bots. Four requirement changes (households, store billing, offline list,
// EU first) each lead to a replan; reviews fail and add conventions; bots ask each other questions.
// Deliverables grow version by version: each new version keeps the earlier text and adds what changed.
import type { PlanInput } from '@context-continue/core';
import type { Scenario } from '../types.js';
import { LongScenarioBuilder, op, rotate } from './long.js';

type Ws = PlanInput['workstreams'][number];
type Contract = PlanInput['contracts'][number];

const W = {
  requirements: {
    id: 'requirements',
    title: 'Product requirements',
    brief: 'Write the product requirements for Larder v1: personas, numbered user stories with acceptance criteria, scope and non-goals, for iOS, Android and the web.',
    owner: 'analyst',
    dependsOn: [],
  },
  ux: {
    id: 'ux',
    title: 'UX flows and UI kit',
    brief: 'Design the onboarding, weekly planner, recipe import and grocery list flows, and a UI kit shared by the web and mobile apps.',
    owner: 'design',
    dependsOn: ['requirements'],
  },
  api: {
    id: 'api',
    title: 'API specification',
    brief: 'Specify the public REST API (resources, authentication, errors, pagination) as an OpenAPI document the web and mobile clients are generated from.',
    owner: 'backend',
    dependsOn: ['requirements'],
  },
  backend: {
    id: 'backend',
    title: 'Backend services',
    brief: 'Implement the API: accounts, meal plans, recipes, grocery lists and recipe import, on Postgres, with automated tests and load numbers.',
    owner: 'backend',
    dependsOn: ['api'],
  },
  web: {
    id: 'web',
    title: 'Web app',
    brief: 'Build the responsive web app for planning meals and editing the grocery list, against the API and the UI kit.',
    owner: 'web',
    dependsOn: ['ux', 'api'],
  },
  mobile: {
    id: 'mobile',
    title: 'iOS and Android apps',
    brief: 'Build the React Native app for iOS and Android: planner, recipe import from the share sheet and the grocery list in the store.',
    owner: 'mobile',
    dependsOn: ['ux', 'api'],
  },
  analytics: {
    id: 'analytics',
    title: 'Product analytics',
    brief: 'Define the event schema for activation and retention and build the launch dashboards.',
    owner: 'analyst',
    dependsOn: ['requirements'],
  },
  security: {
    id: 'security',
    title: 'Security review',
    brief: 'Threat-model the API and the apps, review authentication and the storage of personal data, and list the fixes required before launch.',
    owner: 'ops',
    dependsOn: ['api'],
  },
  infra: {
    id: 'infra',
    title: 'Infrastructure and delivery',
    brief: 'Set up the environments, CI/CD for the API, web and mobile builds, monitoring, alerting and backups.',
    owner: 'ops',
    dependsOn: [],
  },
  testing: {
    id: 'testing',
    title: 'Test plan and test runs',
    brief: 'Write the test plan from the acceptance criteria, automate the end-to-end paths and run the release test passes on the device matrix.',
    owner: 'qa',
    dependsOn: ['backend', 'web', 'mobile'],
  },
} satisfies Record<string, Ws>;

const C: Record<string, Contract> = {
  reqTesting: {
    id: 'c-req-testing',
    from: 'requirements',
    to: 'testing',
    spec: 'Every user story has a numbered id (LR-nn) and acceptance criteria the test plan traces one to one.',
  },
  apiWeb: {
    id: 'c-api-web',
    from: 'api',
    to: 'web',
    spec: 'OpenAPI 3.1 document for /v1, JSON over HTTPS with bearer tokens; the web client is generated from it.',
  },
  apiMobile: {
    id: 'c-api-mobile',
    from: 'api',
    to: 'mobile',
    spec: 'The same OpenAPI 3.1 document; the mobile client is generated from it and a breaking change needs a new API version.',
  },
  uxWeb: {
    id: 'c-ux-web',
    from: 'ux',
    to: 'web',
    spec: 'Screens as Figma frames that use UI kit component names; design tokens exported as JSON.',
  },
  uxMobile: {
    id: 'c-ux-mobile',
    from: 'ux',
    to: 'mobile',
    spec: 'The same frames and tokens, with iOS and Android variants where the platforms differ.',
  },
};

const EMPLOYEES: Scenario['employees'] = [
  { botId: 'pm', persona: 'Product lead who splits the work, reviews every deliverable and keeps the plan consistent with what the owner wants.', skills: ['planning', 'review', 'prioritisation'] },
  { botId: 'analyst', persona: 'Product analyst who writes requirements, defines analytics events and prepares launch material.', skills: ['requirements', 'analytics', 'technical writing'] },
  { botId: 'design', persona: 'Product designer who designs flows, screens and the shared UI kit, and runs quick usability tests.', skills: ['interaction design', 'UI kit', 'accessibility'] },
  { botId: 'backend', persona: 'Backend engineer who specifies the API and builds the services and the database.', skills: ['API design', 'Node.js', 'Postgres'] },
  { botId: 'web', persona: 'Frontend engineer who builds the web app.', skills: ['React', 'performance', 'accessibility'] },
  { botId: 'mobile', persona: 'Mobile engineer who builds the iOS and Android apps in React Native.', skills: ['React Native', 'StoreKit', 'Play Billing', 'offline storage'] },
  { botId: 'qa', persona: 'Test engineer who writes the test plan, automates end-to-end tests and runs release passes.', skills: ['test planning', 'Playwright', 'Detox'] },
  { botId: 'ops', persona: 'Platform and security engineer who runs infrastructure, CI/CD, security reviews and privacy compliance.', skills: ['AWS', 'Terraform', 'security', 'privacy'] },
];

/** Routine progress replies, rotated so consecutive updates do not read the same. */
const PROGRESS: ((done: string, next: string) => string)[] = [
  (d, n) => `Done with ${d}. Next I am on ${n}.`,
  (d, n) => `${d.charAt(0).toUpperCase()}${d.slice(1)} is finished and checked locally; moving on to ${n}.`,
  (d, n) => `Progress update: ${d} works end to end. Starting ${n} now.`,
  (d, n) => `Finished ${d} this morning. ${n.charAt(0).toUpperCase()}${n.slice(1)} is next.`,
];

export function generateLongApp(): Scenario {
  const b = new LongScenarioBuilder({
    id: 'long-app',
    goal: 'Build and launch Larder, a meal-planning app with a shared grocery list, on iOS, Android and the web.',
    constraints: [
      'The first public release ships within one quarter with the eight-person team.',
      'Every screen works on a phone first; the web app is responsive.',
      'Personal data is collected only where a feature needs it.',
    ],
    owner: 'dana',
    lead: 'pm',
    employees: EMPLOYEES,
    plan: {
      workstreams: [W.requirements, W.ux, W.api, W.backend, W.web, W.mobile, W.analytics, W.security, W.infra, W.testing],
      contracts: [C.reqTesting!, C.apiWeb!, C.apiMobile!, C.uxWeb!, C.uxMobile!],
    },
  });

  let turn = 0;
  /** A routine progress step: a short reply and a private note of what is done and what is next. */
  const progress = (bot: string, ws: string, done: string, next: string, extra: ReturnType<typeof op.notes>[] = []) =>
    b.work(bot, ws, rotate(PROGRESS, turn++)(done, next), [...extra, op.notes(`${ws}: done ${done}; next ${next}.`)]);

  // -------------------------------------------------------------------------
  // Phase 1: requirements, API and design
  // -------------------------------------------------------------------------
  b.human(
    'Hi team. We are building Larder, a meal-planning app with a shared grocery list, for iOS, Android and the web. Most people plan dinners on Sunday and shop on Monday, so those two moments matter most. @pm please get the requirements going first; I want the first public release this quarter.',
    ['pm'],
  );
  b.work('analyst', 'requirements', 'Starting the requirements. I will write personas and numbered stories first, then scope and non-goals.', [
    op.board('requirements'),
    op.notes('Requirements plan: personas from the interview notes, stories numbered LR-nn, scope for v1, explicit non-goals.', true),
  ]);
  b.ask('analyst', 'requirements', 'design', {
    reply: 'Before I fix the personas I want to reuse any research we already have.',
    question: 'do you have notes from the household interviews on who plans meals and who does the shopping?',
  });
  b.answer('design', 'ux', 'analyst', 'Yes: 9 interviews. In 7 households one person plans on Sunday evening and another shops, usually on Monday after work. Shoppers complained about lists that do not sort by aisle and about bad signal inside stores.', [
    op.notes('Shared interview summary with analyst: planner and shopper are usually different people; in-store signal is poor.'),
  ]);
  b.work('ops', 'infra', 'Setting up the environments first so the others have somewhere to deploy.', [
    op.decide(
      'Use one AWS account per environment (dev, staging, prod), all provisioned with Terraform from one repository.',
      'Separate accounts limit the blast radius of a mistake and make production access auditable.',
      ['One shared account with tagged resources'],
      ['infra'],
    ),
    op.notes('infra: dev and staging accounts created; prod after the first security review.'),
  ]);
  b.deliver('analyst', 'requirements', {
    reply: 'First version of the requirements: personas, scope, non-goals and six stories.',
    summary: 'Personas, v1 scope and non-goals, stories LR-01 to LR-06',
    add: [
      'Personas: the weekly planner plans dinners for a household of two to five on Sunday evening; the shopper takes the list to the store on Monday, often with poor signal; the occasional cook opens a recipe on the phone in the kitchen.',
      'Scope for v1: a weekly meal plan (7 days, up to 3 meals a day), a recipe library with import from a URL, a grocery list generated from the plan and merged by ingredient, and Larder Plus (unlimited recipes, pantry tracking) at USD 4.99 a month. Non-goals: nutrition tracking, grocery delivery integrations, a social feed.',
      'Stories: LR-01 plan a week; LR-02 import a recipe from a URL; LR-03 generate the grocery list; LR-04 tick items off in the store; LR-05 subscribe to Larder Plus; LR-06 delete my account.',
    ],
  });
  b.review('requirements', false, 'Good personas and a clear scope, but the stories have no acceptance criteria, so neither QA nor the engineers can tell when a story is done. Add criteria to every story.', [
    'Acceptance criteria are written as Given/When/Then, one per behaviour, under the story id (CONV-GIVEN-WHEN-THEN).',
  ]);
  b.fact('conv-given-when-then', 'CONV-GIVEN-WHEN-THEN', ['analyst', 'qa']);
  progress('ops', 'infra', 'the Terraform modules for networking and Postgres', 'the CI pipelines for the API and the web app');
  b.deliver('analyst', 'requirements', {
    reply: 'Added Given/When/Then acceptance criteria to the stories.',
    summary: 'Stories now carry Given/When/Then acceptance criteria',
    add: [
      'Acceptance criteria (Given/When/Then): LR-01 Given an empty week, when I drag a recipe onto Tuesday dinner, then it appears there on every device within 5 seconds. LR-03 Given two planned recipes that both use onions, when I generate the list, then onions appear once with the summed quantity. LR-04 Given an item on the list, when I tick it, then it moves to the bottom and stays ticked after a reload.',
    ],
  });
  b.review('requirements', true, 'Criteria are testable now. Approved; this is the baseline for API and design work.');
  b.work('backend', 'api', 'Starting the API specification from the approved requirements.', [
    op.board('requirements'),
    op.notes('api: resources from LR-01..LR-06; magic-link login; recipe import as an async job.'),
  ]);
  b.work('design', 'ux', 'Starting the flows: onboarding, planner, recipe import and the grocery list.', [
    op.board('requirements'),
    op.notes('ux: list grouped by aisle (from interviews); planner is a week grid; import shows parsed ingredients before saving.'),
  ]);
  b.ask('analyst', 'analytics', 'backend', {
    reply: 'Drafting the analytics events.',
    question: 'which user identifier will the API expose to the clients: the account id, or something else I should put on events?',
  });
  b.answer('backend', 'api', 'analyst', 'Clients get the account id, a UUID v7. There is no other stable identifier; email can change.');
  b.deliver('ops', 'infra', {
    reply: 'Environments and pipelines are in place. Submitting the infrastructure baseline.',
    summary: 'Three AWS accounts, Terraform, CI for API and web, nightly mobile builds, monitoring',
    add: [
      'Environments: dev, staging and prod in separate AWS accounts, provisioned with Terraform from the infra repository; changes go through pull requests and a plan review.',
      'Delivery: GitHub Actions builds and tests the API and the web app on every push and deploys main to staging; production deploys are manual promotions of a staging build. Mobile builds run nightly on EAS and go to TestFlight and the Play internal track.',
      'Operations: Grafana dashboards for latency and error rate, PagerDuty alerts on a 2% 5xx rate for five minutes, daily Postgres snapshots kept for 14 days.',
    ],
  });
  b.review('infra', true, 'Solid baseline. Approved.');
  b.deliver('backend', 'api', {
    reply: 'First draft of the OpenAPI document is ready for review.',
    summary: 'Resources, auth and pagination for /v1',
    add: [
      'Resources: /v1/auth (email magic link, refresh tokens), /v1/recipes, /v1/plans/{week}, /v1/lists/{id}/items and /v1/import (URL to recipe, asynchronous). JSON over HTTPS; bearer access tokens valid for 15 minutes, refresh tokens for 60 days.',
      'Pagination uses page and pageSize query parameters. Dates are sent as the local date and time strings the user entered.',
    ],
  });
  b.review('api', false, 'Two problems. Page-based pagination breaks when items are added while a client pages through a list, which happens all the time on a shared list. Local time strings will break plans across time zones and daylight saving. Fix both.', [
    'List endpoints use cursor pagination: cursor and limit parameters, nextCursor in the response, limit at most 100 (CONV-CURSOR-PAGINATION).',
    'Every timestamp in the API and in events is ISO 8601 in UTC with a Z suffix; calendar days are plain YYYY-MM-DD dates (CONV-ISO8601-UTC).',
  ]);
  b.fact('conv-cursor-pagination', 'CONV-CURSOR-PAGINATION', ['backend', 'web', 'mobile']);
  b.fact('conv-iso8601-utc', 'CONV-ISO8601-UTC', ['backend', 'web', 'mobile', 'analyst']);
  b.work('web', 'web', 'Reading the draft API while the design is in progress, so the client generator is set up early.', [
    op.board('api'),
    op.notes('web: React 19 + Vite; generate the client from the OpenAPI document once it passes review.'),
  ]);
  b.ask('design', 'ux', 'analyst', {
    reply: 'Laying out the planner screen.',
    question: 'is sharing a meal plan with another person in scope for v1, or only the grocery list?',
  });
  b.answer('analyst', 'requirements', 'design', 'Only the grocery list is shared in v1; the plan is personal. If the owner asks for households later we will revisit it.');
  b.deliver('backend', 'api', {
    reply: 'Revised the API: cursor pagination everywhere and UTC timestamps.',
    summary: 'Cursor pagination and ISO 8601 UTC timestamps',
    add: [
      'Revision after review: pagination is cursor-based on every list endpoint (cursor and limit, at most 100, nextCursor in the response); page and pageSize are removed. Every timestamp is ISO 8601 in UTC with a Z suffix and plan days are plain YYYY-MM-DD dates, so a plan reads the same in every time zone.',
    ],
  });
  b.review('api', true, 'Approved. Web and mobile can generate their clients from this version.');
  b.deliver('design', 'ux', {
    reply: 'First version of the flows and the UI kit.',
    summary: 'Onboarding, planner, import and grocery list flows; UI kit',
    add: [
      'Flows: onboarding in three screens (household name, dietary preferences, first week); planner as a week grid with drag and drop; recipe import (paste a URL, review the parsed ingredients, save); grocery list grouped by aisle, where ticking an item moves it to the bottom.',
      'UI kit: 8 px grid, Inter for text, colour tokens larder-green-600 for primary actions and slate for text; components Button, Chip, RecipeCard, ListItem, WeekGrid and Sheet.',
      'Empty states and errors: every screen has an empty state with one primary action; errors show the server message and a retry button.',
    ],
  });
  b.review('ux', false, 'The flows are good, but ticked items are light grey on white (about 2.4:1) and several icon buttons are 32 points. People will use this in bright supermarkets. Fix the contrast and the target sizes.', [
    'Text and icons meet WCAG 2.2 AA contrast (4.5:1 for text, 3:1 for icons) and touch targets are at least 44 x 44 points (CONV-WCAG-AA-CONTRAST).',
  ]);
  b.fact('conv-wcag-aa-contrast', 'CONV-WCAG-AA-CONTRAST', ['design', 'web', 'mobile', 'qa']);
  b.work('mobile', 'mobile', 'Starting the mobile app: project setup, navigation and the generated API client.', [
    op.board('api'),
    op.notes('mobile: React Native 0.80, Expo modules, client generated from the OpenAPI document; share sheet extension for recipe import.'),
  ]);
  b.deliver('analyst', 'analytics', {
    reply: 'First version of the event schema and the dashboard list.',
    summary: 'Activation and retention events and two dashboards',
    add: [
      'Events: app_opened, plan_created, recipe_imported, list_generated, item_ticked and subscription_started; each event carries the user email and the household name so the dashboards can be filtered by customer.',
      'Dashboards: activation (first plan within 24 hours of sign-up) and week-2 retention (planned or shopped in the second week), split by platform.',
    ],
  });
  b.deliver('design', 'ux', {
    reply: 'Fixed contrast and target sizes across the kit.',
    summary: 'WCAG 2.2 AA contrast and 44-point targets',
    add: [
      'Accessibility: ticked items now use slate-600 with a strike-through (5.1:1), primary buttons are 4.8:1, and every interactive target is at least 44 x 44 points. Checked every screen against WCAG 2.2 AA.',
    ],
  });
  b.review('ux', true, 'Approved. Web and mobile can build against this version.');
  b.review('analytics', false, 'We cannot send email addresses and household names to the analytics vendor; that is personal data we do not need for these dashboards.', [
    'Analytics events never carry personal data: no email, names or free text; users are identified only by a salted hash of the account id (CONV-NO-PII-IN-EVENTS).',
  ]);
  b.fact('conv-no-pii-in-events', 'CONV-NO-PII-IN-EVENTS', ['analyst', 'web', 'mobile']);
  b.work('ops', 'security', 'Starting the threat model from the approved API.', [
    op.board('api'),
    op.notes('security: STRIDE over auth, import, lists; check token storage on devices; check the import fetcher for SSRF.'),
  ]);
  b.work('backend', 'backend', 'Starting the services on Postgres.', [
    op.decide(
      'One Node 22 service (Fastify) with Postgres 16; recipe import runs in a separate worker process.',
      'One deployable keeps operations simple for a small team; the worker isolates slow and untrusted URL fetches.',
      ['Separate microservices per resource'],
      ['backend'],
    ),
  ]);
  b.ask('web', 'web', 'backend', {
    reply: 'Wiring up error handling in the web client.',
    question: 'what does an error response look like, so the client can show the server message and retry where it makes sense?',
  });
  b.answer(
    'backend',
    'backend',
    'web',
    'Every error is {code, message, requestId} with a 4xx or 5xx status (CONTRACT-ERROR-ENVELOPE); code is a stable string like LIST_NOT_FOUND, message is safe to show to the user, and a 429 or 503 carries Retry-After. @mobile the same applies to you.',
    [],
    ['mobile'],
  );
  b.fact('contract-error-envelope', 'CONTRACT-ERROR-ENVELOPE', ['web', 'mobile']);
  b.human('@design I tried the onboarding prototype with my partner and it felt long: three screens before we saw anything useful. Can we get people to a first plan faster?', ['design']);
  b.deliver('design', 'ux', {
    reply: 'Shortened onboarding to one screen and tested it with six people.',
    summary: 'One-screen onboarding with suggested dinners',
    add: [
      'Onboarding shortened to one screen: household name and an optional row of dietary chips. The first week is created with three suggested dinners the user can swap. In a usability test with 6 people the median time to a first plan fell from 3 min 40 s to 1 min 10 s.',
    ],
  });
  b.review('ux', true, 'Much better. Approved.');
  progress('mobile', 'mobile', 'navigation and the generated API client', 'the planner week grid');
  progress('web', 'web', 'the generated API client and error handling', 'the planner route');
  b.deliver('ops', 'security', {
    reply: 'First version of the threat model.',
    summary: 'STRIDE threat model for API, web and apps',
    add: [
      'Threat model (STRIDE): stolen magic-link tokens (links are single use and expire after 15 minutes), server-side request forgery through recipe import, injection through list item text (all output is escaped), tokens on devices (Keychain on iOS, Keystore on Android, httpOnly cookies on the web).',
      'Open items: dependency scanning in CI, a penetration test two weeks before launch.',
    ],
  });
  b.review('security', false, 'The recipe importer fetches any URL a user gives it, and nothing limits how often someone can request login links. Both need concrete fixes before we go further.', [
    'Every public endpoint is rate limited per IP and per account, and limits are documented in the API (CONV-RATE-LIMITS-DOCUMENTED).',
  ]);
  b.deliver('backend', 'backend', {
    reply: 'First version of the backend services.',
    summary: 'Accounts, plans, recipes, lists and import on Postgres; tests and load numbers',
    add: [
      'Services: one Node 22 service (Fastify) with Postgres 16; tables accounts, recipes, plans, plan_entries, lists and list_items. Recipe import runs in a worker with a 10 second timeout per URL and parses schema.org Recipe data, falling back to the page text.',
      'Tests: 212 unit and integration tests with 84% line coverage. In staging, list edits have a p95 latency of 38 ms at 200 requests per second.',
    ],
  });
  b.review('backend', false, 'Mobile retries on flaky networks will create duplicate list items and duplicate imports: POST is not idempotent. Fix it before clients depend on it.', [
    'Every POST accepts an Idempotency-Key header; the server keeps keys for 24 hours and a replay returns the first response (CONV-IDEMPOTENCY-KEY).',
  ]);
  b.fact('conv-idempotency-key', 'CONV-IDEMPOTENCY-KEY', ['backend', 'mobile', 'web']);
  b.ask('mobile', 'mobile', 'design', {
    reply: 'Building the planner for tablets as well.',
    question: 'do you want a separate tablet layout for the planner, or should the phone layout just stretch?',
  });
  b.answer('design', 'ux', 'mobile', 'Stretch the phone layout for v1, but cap the content width at 720 points so the week grid does not get too wide.');
  b.deliver('backend', 'backend', {
    reply: 'Added idempotency keys to every POST.',
    summary: 'Idempotency keys on every POST',
    add: [
      'Idempotency: every POST accepts an Idempotency-Key header; keys are stored for 24 hours and a replay returns the first response. Duplicate list items from retries no longer occur, verified with a 30% packet-loss test.',
    ],
  });
  b.review('backend', true, 'Approved.');

  // -------------------------------------------------------------------------
  // Change 1: households
  // -------------------------------------------------------------------------
  b.human(
    'Change of plan after the beta interviews (CHANGE-HOUSEHOLD-6): people do not want separate accounts, they want a household. One household of up to 6 members shares the meal plan and the grocery list, and everyone sees who added or ticked an item. This replaces the single-user model from the requirements.',
  );
  b.fact('change-household-6', 'CHANGE-HOUSEHOLD-6', ['*']);
  b.replan({
    workstreams: [
      { ...W.requirements, brief: 'Write the product requirements for Larder v1: personas, numbered user stories with acceptance criteria, scope and non-goals, including households of up to 6 members.' },
      W.ux,
      W.api,
      W.backend,
      W.web,
      W.mobile,
      W.analytics,
      W.security,
      W.infra,
      {
        id: 'sharing',
        title: 'Household sharing',
        brief: 'Build households: invites, member roles, and syncing plan and list edits between members.',
        owner: 'backend',
        dependsOn: ['api'],
      },
      { ...W.testing, dependsOn: ['backend', 'web', 'mobile', 'sharing'] },
    ],
    contracts: [
      C.reqTesting!,
      C.apiWeb!,
      C.apiMobile!,
      C.uxWeb!,
      C.uxMobile!,
      {
        id: 'c-sharing-clients',
        from: 'sharing',
        to: 'mobile',
        spec: 'POST /v1/households/{id}/invites returns a single-use invite link that expires after 72 hours (CONTRACT-INVITE-LINK-72H); members have role owner or member; list and plan edits are read from GET /v1/lists/{id}/changes. The web app uses the same endpoints.',
      },
    ],
  });
  b.fact('contract-invite-link-72h', 'CONTRACT-INVITE-LINK-72H', ['web', 'mobile']);
  b.deliver('analyst', 'requirements', {
    reply: 'Updated the requirements for households.',
    summary: 'Households of up to 6 members; stories LR-07 to LR-09',
    add: [
      'Households: every account belongs to one household of up to 6 members that shares the meal plan and the grocery list. LR-07 invite a member by link; LR-08 see who added or ticked an item; LR-09 leave a household, or remove a member as its owner. Given two members ticking different items at the same time, when both lists sync, then both ticks survive.',
    ],
  });
  b.review('requirements', true, 'Approved. This matches what the owner asked for.');
  b.work('backend', 'sharing', 'Starting household sharing. First the data model: households, memberships and invites.', [
    op.board('c-sharing-clients'),
    op.notes('sharing: household_id on every plan and list row; memberships(role); invites stored hashed; change log per list.'),
  ]);
  b.work('backend', 'sharing', 'Prototyped live sync over websockets and dropped it; recording why.', [
    op.failure(
      'Pushing every list edit to all household members over one websocket per device (FAIL-WEBSOCKET-FANOUT).',
      'Phones drop the socket in the background, so edits were missed anyway, and holding open sockets for every device drained batteries and needed sticky sessions. Silent push plus the change feed covers it.',
      ['sharing', 'mobile', 'web'],
    ),
  ]);
  b.fact('fail-websocket-fanout', 'FAIL-WEBSOCKET-FANOUT', ['backend', 'mobile', 'web']);
  progress('analyst', 'analytics', 'an event validator in CI that rejects events with unknown fields', 'removing personal data from the event payloads');
  b.deliver('analyst', 'analytics', {
    reply: 'Removed personal data from the events.',
    summary: 'Events identified by a salted account hash only',
    add: [
      'Revision after review: events carry only a salted hash of the account id and of the household id; email, names and free text are gone. The dashboards keep working because activation and retention only need a stable id per user.',
    ],
  });
  b.deliver('backend', 'api', {
    reply: 'Added the household endpoints to the API.',
    summary: 'Households, members and invites',
    add: [
      'Households: /v1/households, /v1/households/{id}/members and /v1/households/{id}/invites. Every list and plan belongs to a household; members have role owner or member, and only owners remove members. Invite links are single use and expire after 72 hours.',
    ],
  });
  b.review('api', true, 'Approved.');
  b.ask('mobile', 'mobile', 'backend', {
    reply: 'Planning how the app learns about edits from other members.',
    question: 'what is in the silent push when another member edits the list, and should the app pull the change feed right away?',
  });
  b.answer('backend', 'sharing', 'mobile', 'The silent push carries only the list id and the latest cursor, no item text. Pull GET /v1/lists/{id}/changes with your stored cursor when the push arrives and when the app comes to the foreground.');
  b.deliver('design', 'ux', {
    reply: 'Designed the household screens.',
    summary: 'Members, invites and who-did-what on list items',
    add: [
      'Household screens: a member list with roles, an invite sheet with a share link and a note that it expires after 72 hours, and small avatars on list items that show who added or ticked them.',
    ],
  });
  b.review('ux', true, 'Approved.');
  progress('web', 'web', 'the planner route with drag and drop', 'the grocery list route');
  b.deliver('ops', 'security', {
    reply: 'Added the import and rate-limit fixes, and covered invites.',
    summary: 'Import egress proxy, documented rate limits, invite links',
    add: [
      'Fixes: recipe import fetches through an egress proxy that blocks private and link-local IP ranges and follows at most 3 redirects. Login-link and invite endpoints are limited to 5 requests per minute per IP and 20 per hour per account; the limits are listed in the API document.',
      'Households: invite links are stored as SHA-256 hashes, are single use, and a removed member loses access on the next request.',
    ],
  });
  b.review('security', true, 'Approved.');
  b.ask('backend', 'sharing', 'mobile', {
    reply: 'Adding push registration to the sharing service.',
    question: 'will the app register one push token per device or one per account, and does it send a new token after a reinstall?',
  });
  b.answer('mobile', 'mobile', 'backend', 'One token per device installation, sent with POST /v1/devices on every launch; a reinstall produces a new token and the old one starts failing, so drop tokens the push service rejects.');
  b.deliver('backend', 'sharing', {
    reply: 'First version of household sharing.',
    summary: 'Invites, roles and the list change feed',
    add: [
      'Invites: single-use links that expire after 72 hours, stored hashed. Roles: owner and member. Every plan and list row carries household_id and Postgres row-level security enforces it.',
      'Sync: every edit is written to list_changes with a monotonically increasing cursor; members get a silent push with the list id and cursor and pull GET /v1/lists/{id}/changes. Websockets were tried and dropped (see the recorded failure).',
    ],
  });
  b.review('sharing', true, 'Approved; a simple design that survives phones going to sleep.');
  b.human('How are we tracking against the quarter? I would like a short status from each of you by the end of the week.');
  const status = (bot: string, ws: string, text: string) => b.work(bot, ws, `Status: ${text}`, [op.message(`Status for the week: ${text}`, 'inform')]);
  status('analyst', 'requirements', 'requirements are approved with households (LR-01 to LR-09); the analytics events are revised and waiting for review.');
  status('design', 'ux', 'flows, UI kit and household screens are approved; next I support web and mobile and run one more usability test on the list.');
  status('backend', 'sharing', 'API and household sharing are approved; the service migration to households is in review this week. On track.');
  status('web', 'web', 'planner and list routes work against staging; household settings and the subscription panel are next. About a week of work left before the first full version.');
  status('mobile', 'mobile', 'planner, import and the list work on both platforms; invites and payments are next. Payments are the risk: App Review has not seen our checkout yet.');
  status('ops', 'security', 'infrastructure is approved and the security fixes are in; I start the penetration test booking for two weeks before launch.');
  status('qa', 'testing', 'nothing to test end to end yet; I am preparing the staging seed data and the Playwright project so the first run can start the day web is ready.');
  b.ask('qa', 'testing', 'backend', {
    reply: 'Preparing staging data for the end-to-end tests.',
    question: 'can staging get a seed script with three households (one, three and six members) and a few hundred recipes, reset every night?',
  });
  b.answer('backend', 'backend', 'qa', 'Yes: npm run seed:staging creates the three households and 300 recipes from the open recipe set; the nightly deploy now runs it after migrations.');
  progress('qa', 'testing', 'the Playwright project and fixtures for the three seeded households', 'reading the acceptance criteria for test design');
  progress('mobile', 'mobile', 'the planner and recipe import from the share sheet', 'household invites through universal links');
  b.deliver('backend', 'backend', {
    reply: 'Migrated the services to households.',
    summary: 'household_id with row-level security, backfill migration',
    add: [
      'Households: every plan and list row carries household_id, enforced by Postgres row-level security. A migration created a one-member household for every existing account; tests grew to 268.',
    ],
  });
  b.review('backend', true, 'Approved.');
  b.work('mobile', 'mobile', 'Tried the existing web checkout for Larder Plus inside the iOS app; it did not get through review. Recording it.', [
    op.failure(
      'Opening the Stripe web checkout for Larder Plus in a webview inside the iOS and Android apps (FAIL-STRIPE-IN-WEBVIEW).',
      'TestFlight external review rejected the build under App Store guideline 3.1.1: digital subscriptions bought in the app must use in-app purchase. Google Play has the same rule.',
      ['mobile'],
    ),
    op.message('Heads-up: App Review rejected the build because Larder Plus is bought through a Stripe webview. We cannot ship that.', 'inform'),
  ]);
  b.fact('fail-stripe-in-webview', 'FAIL-STRIPE-IN-WEBVIEW', ['mobile', 'web', 'backend']);

  // -------------------------------------------------------------------------
  // Change 2: store billing
  // -------------------------------------------------------------------------
  b.human(
    'Change of plan on payments (CHANGE-STORE-BILLING): after the App Review rejection we switch Larder Plus to App Store and Google Play billing instead of Stripe. One subscription covers the whole household. The web app no longer sells anything; it only shows the plan and where to manage it.',
  );
  b.fact('change-store-billing', 'CHANGE-STORE-BILLING', ['backend', 'web', 'mobile', 'qa']);
  b.replan({
    workstreams: [
      b.currentPlan.workstreams.find(w => w.id === 'requirements')!,
      W.ux,
      W.api,
      W.backend,
      { ...W.web, brief: 'Build the responsive web app for planning meals and editing the grocery list, against the API and the UI kit. The web app shows the subscription but sells nothing.' },
      W.mobile,
      W.analytics,
      W.security,
      W.infra,
      b.currentPlan.workstreams.find(w => w.id === 'sharing')!,
      {
        id: 'billing',
        title: 'Store billing',
        brief: 'Verify App Store and Google Play receipts on the server and keep each household\'s Larder Plus entitlement up to date, including renewals and refunds.',
        owner: 'backend',
        dependsOn: ['api'],
      },
      { ...W.testing, dependsOn: ['backend', 'web', 'mobile', 'sharing', 'billing'] },
    ],
    contracts: [
      ...b.currentPlan.contracts,
      {
        id: 'c-billing-mobile',
        from: 'billing',
        to: 'mobile',
        spec: 'The app posts the raw store receipt to POST /v1/billing/receipts (CONTRACT-RECEIPT-POST) with an Idempotency-Key; the response is the household entitlement {plan, expiresAt, source}. GET /v1/billing/entitlement returns the same for any member.',
      },
    ],
  });
  b.fact('contract-receipt-post', 'CONTRACT-RECEIPT-POST', ['mobile', 'qa']);
  b.deliver('analyst', 'requirements', {
    reply: 'Rewrote LR-05 for store billing.',
    summary: 'Store billing for the household; web shows status only',
    add: [
      'Billing: Larder Plus is bought through the App Store or Google Play only and covers the whole household; the web app shows the plan and links to the store to manage it. LR-05 is rewritten: Given a member on iOS, when they subscribe, then every member of the household has Plus within one minute on every device.',
    ],
  });
  b.review('requirements', true, 'Approved.');
  b.ask('backend', 'billing', 'ops', {
    reply: 'Starting server-side receipt verification.',
    question: 'where should the App Store Connect key and the Play service account live, and who can read them in production?',
  });
  b.answer('ops', 'infra', 'backend', 'Both go in AWS Secrets Manager in the prod account, readable only by the API task role; I have created the two secrets and rotation reminders. Never put them in environment files.', [
    op.notes('infra: created secrets billing/appstore-key and billing/play-sa in prod; API task role only.'),
  ]);
  progress('backend', 'billing', 'App Store Server API verification against the sandbox', 'renewal and refund notifications from both stores');
  b.deliver('backend', 'billing', {
    reply: 'First version of store billing.',
    summary: 'Receipt verification and household entitlements',
    add: [
      'Receipts: POST /v1/billing/receipts verifies App Store receipts with the App Store Server API and Play purchases with the Play Developer API, then stores the entitlement on the household. App Store Server Notifications v2 and Play real-time developer notifications update renewals, refunds and expiries.',
      'Entitlement: GET /v1/billing/entitlement returns {plan, expiresAt, source}; Plus features check it on the server, never on the device.',
    ],
  });
  b.review('billing', true, 'Approved.');
  b.deliver('backend', 'api', {
    reply: 'Updated the API for store billing.',
    summary: 'Billing endpoints; Stripe endpoints removed',
    add: [
      'Billing: POST /v1/billing/receipts accepts an App Store or Google Play receipt and GET /v1/billing/entitlement returns {plan, expiresAt, source}. The Stripe checkout and webhook endpoints are removed.',
    ],
  });
  b.review('api', true, 'Approved.');
  b.ask('web', 'web', 'mobile', {
    reply: 'Building the subscription panel in settings.',
    question: 'when a household is subscribed through the App Store or Play, what wording do you show for managing it, so the web says the same thing?',
  });
  b.answer('mobile', 'mobile', 'web', 'We say "Larder Plus for your household, renews on <date>. Manage it in the App Store" (or Google Play), using source from the entitlement. Only the member who bought it can cancel.');
  b.deliver('web', 'web', {
    reply: 'First version of the web app.',
    summary: 'Planner, recipes, grocery list, household and subscription settings',
    add: [
      'Built with React 19 and Vite; routes /plan, /recipes, /list and /settings; the API client is generated from the OpenAPI document. Errors show the server message and retry when Retry-After is set.',
      'Household settings list the members with roles and create invite links; the subscription panel shows the household plan and "Manage it in the App Store" or "in Google Play", with no purchase flow. Bundle size is 410 KB gzipped.',
    ],
  });
  b.review('web', false, 'Functionally right, but 410 KB gzipped is far over our 250 KB budget and the planner takes 4 seconds to become usable on a mid-range phone. Bring it under budget.');
  b.deliver('mobile', 'mobile', {
    reply: 'First full version of the mobile app, with store billing.',
    summary: 'Planner, import, list, households, StoreKit 2 and Play Billing',
    add: [
      'React Native 0.80 app for iOS 17+ and Android 10+; planner, recipe import from the share sheet and the grocery list; the API client is shared with the web app.',
      'Households: invites open through universal links and app links; list items show who added or ticked them. Store billing uses StoreKit 2 and Play Billing 7; the raw receipt goes to POST /v1/billing/receipts with an Idempotency-Key.',
    ],
  });
  b.review('mobile', false, 'There is no restore purchases action, and App Review requires one. On Android a member who reinstalls loses Plus until the subscriber opens the app.', [
    'Every paid feature has a restore path that works on a fresh install for any household member (CONV-RESTORE-PATH).',
  ]);
  b.deliver('web', 'web', {
    reply: 'Brought the web app under the size budget.',
    summary: 'Bundle 212 KB gzipped, LCP 1.6 s',
    add: [
      'Performance: the recipes and settings routes are lazy loaded and the date library is replaced by Intl; the bundle is 212 KB gzipped and LCP is 1.6 s on a mid-range phone over 4G.',
    ],
  });
  b.review('web', true, 'Approved.');
  b.deliver('mobile', 'mobile', {
    reply: 'Added restore purchases on both platforms.',
    summary: 'Restore purchases; entitlement read from the server',
    add: [
      'Restore: settings has Restore purchases on both platforms; on Android it re-queries Play purchases and posts them. Every member reads Plus from GET /v1/billing/entitlement, so a reinstall shows Plus right away without the subscriber opening the app.',
    ],
  });
  b.review('mobile', true, 'Approved.');
  b.human('Thanks, everyone. The household beta testers love seeing who ticked what.');

  // -------------------------------------------------------------------------
  // Change 3: offline list, analytics dashboards dropped
  // -------------------------------------------------------------------------
  b.human('@web on my laptop the grocery list is one long column with lots of empty space. Could it use two columns on wide screens?', ['web']);
  progress('web', 'web', 'a two-column grocery list on screens wider than 1024 px, split by aisle', 'checking it against the WCAG contrast rules');
  b.deliver('ops', 'security', {
    reply: 'Reviewed billing and household sharing for security.',
    summary: 'Security review of receipts, entitlements and the change feed',
    add: [
      'Billing and sharing: receipts are verified only on the server and entitlements are checked on every Plus request; store notification endpoints verify the Apple JWS signature and the Google Pub/Sub token. The change feed checks household membership on every call and silent pushes carry no item text.',
    ],
  });
  b.review('security', true, 'Approved.');
  b.work('qa', 'testing', 'Starting the test plan from the acceptance criteria.', [
    op.board('c-req-testing'),
    op.notes('testing: trace LR-01..LR-09 to cases; Playwright for web, Detox for mobile; device matrix TBD.'),
  ]);
  b.ask('qa', 'testing', 'analyst', {
    reply: 'Tracing the stories to test cases.',
    question: 'for LR-04, when two ticked items move to the bottom, which order should they keep: the order they were ticked or the aisle order?',
  });
  b.answer('analyst', 'requirements', 'qa', 'Ticked items keep aisle order among themselves; I will add that criterion to LR-04 in the next version.');
  b.human(
    'Change of requirements from the in-store tests (CHANGE-OFFLINE-LIST): shoppers lose signal in half the supermarkets we visited, so the grocery list must work fully offline and sync when the phone is back online. To make room, drop the analytics dashboards for launch; we keep logging events and build dashboards after launch.',
  );
  b.fact('change-offline-list', 'CHANGE-OFFLINE-LIST', ['mobile', 'backend', 'qa', 'analyst']);
  b.replan({
    workstreams: [
      ...b.currentPlan.workstreams.filter(w => w.id !== 'analytics' && w.id !== 'testing'),
      {
        id: 'offline',
        title: 'Offline grocery list',
        brief: 'Make the grocery list work fully offline on iOS and Android: local storage, queued edits and reconciliation with other members on reconnect.',
        owner: 'mobile',
        dependsOn: ['sharing'],
      },
      { ...W.testing, dependsOn: ['backend', 'web', 'mobile', 'sharing', 'billing', 'offline'] },
    ],
    contracts: [
      ...b.currentPlan.contracts,
      {
        id: 'c-sharing-offline',
        from: 'sharing',
        to: 'offline',
        spec: 'Change feed: GET /v1/lists/{id}/changes?cursor= returns the edits after the cursor in order (CONTRACT-SYNC-CURSOR); each edit carries the clientEditId and a server timestamp; the last writer wins per item field and a delete wins over an edit.',
      },
    ],
  });
  b.fact('contract-sync-cursor', 'CONTRACT-SYNC-CURSOR', ['mobile', 'qa']);
  b.deliver('analyst', 'requirements', {
    reply: 'Added the offline story and the LR-04 ordering rule; dashboards are out of scope.',
    summary: 'Offline list (LR-10), ticked-item order, dashboards dropped',
    add: [
      'Offline: LR-10 Given no signal in the store, when I tick items and add milk, then the changes are kept and sent when the phone is back online, without losing other members\' edits. LR-04 adds: ticked items keep aisle order among themselves. Analytics dashboards are out of scope for launch; events are still logged.',
    ],
  });
  b.review('requirements', true, 'Approved.');
  b.work('mobile', 'offline', 'Starting the offline list from the sync contract.', [
    op.board('c-sharing-offline'),
    op.notes('offline: SQLite via op-sqlite; queue edits with clientEditId; replay in order; then pull the change feed from the stored cursor.', true),
  ]);
  b.work('mobile', 'offline', 'The first approach lost edits; recording it before trying the queue.', [
    op.failure(
      'Reconnecting by downloading the whole list and overwriting the local copy (FAIL-FULL-LIST-RESYNC).',
      'Items added or ticked offline were silently lost whenever the download finished before the queued edits were sent, and other members saw their ticks flicker.',
      ['offline', 'sharing'],
    ),
  ]);
  b.fact('fail-full-list-resync', 'FAIL-FULL-LIST-RESYNC', ['mobile', 'qa', 'backend']);
  b.ask('design', 'ux', 'mobile', {
    reply: 'Designing the offline states.',
    question: 'how long can the queue get in practice, and do you want the offline banner on every screen or only on the list?',
  });
  b.answer('mobile', 'offline', 'design', 'In the store tests the longest queue was 23 edits. Only the list works offline, so put the banner on the list and a small cloud icon in the tab bar elsewhere.');
  b.deliver('design', 'ux', {
    reply: 'Added the offline states to the list.',
    summary: 'Offline banner, queued items and conflict toast',
    add: [
      'Offline states: a banner "Offline - changes will sync" on the list, queued items marked with a small clock icon, a cloud icon in the tab bar on other screens, and a toast when an item you edited was removed by another member.',
    ],
  });
  b.review('ux', true, 'Approved.');
  b.deliver('backend', 'sharing', {
    reply: 'Hardened the change feed for offline clients.',
    summary: 'clientEditId replay, 30-day feed retention',
    add: [
      'Offline clients: PATCH and POST on list items accept clientEditId, so a replayed queue is applied once. The change feed keeps 30 days of edits; a client with an older cursor gets 410 and reloads the list after sending its queue.',
    ],
  });
  b.review('sharing', true, 'Approved.');
  b.deliver('mobile', 'offline', {
    reply: 'First version of the offline list.',
    summary: 'SQLite store, queued edits, ordered replay',
    add: [
      'Local store in SQLite through op-sqlite; every edit is queued with a clientEditId. On reconnect the queue is sent in order, then the change feed is pulled from the stored cursor. Full list downloads are no longer used (see the recorded failure).',
      'Scope: only the grocery list works offline; the planner and recipes show cached data read-only. The queue survives the app being killed, and the offline banner and clock icons follow the UX design.',
    ],
  });
  b.review('offline', false, 'In my test an item that another member deleted came back after I ticked it offline. A delete has to win over an edit, as the contract says.', [
    'Sync conflicts follow the contract: the last writer wins per field and a delete wins over an edit; the losing side is told in the UI (CONV-DELETE-WINS).',
  ]);
  progress('qa', 'testing', 'the traceability matrix for LR-01 to LR-10', 'the Detox offline scenarios');
  b.ask('qa', 'testing', 'mobile', {
    reply: 'Automating the offline cases.',
    question: 'how do I put the app offline inside a Detox test on both platforms?',
  });
  b.answer('mobile', 'offline', 'qa', 'Use the debug-only setNetworkMode(offline) bridge I added; it blocks the API client and the push handler without touching the simulator network, so Detox keeps its own connection.');
  b.deliver('mobile', 'offline', {
    reply: 'Fixed delete-versus-edit conflicts.',
    summary: 'Delete wins; conflict toast; 3-device test',
    add: [
      'Conflicts: an edit to an item another member deleted is dropped and the conflict toast tells the user. Tested with 3 devices and 200 random offline edits per device; no edit was lost and every device ended with the same list.',
    ],
  });
  b.review('offline', true, 'Approved.');
  b.deliver('qa', 'testing', {
    reply: 'First version of the test plan and the first automated run.',
    summary: 'Test plan traced to LR-01..LR-10, Playwright and Detox suites',
    add: [
      'Plan: every story LR-01 to LR-10 traces to at least one case; 64 automated cases (Playwright for the web, Detox for mobile) and 18 manual ones for billing and invites.',
      'First run on build 412: 61 of 64 automated cases pass; the three failures are flaky waits in the planner drag and drop, now fixed.',
    ],
  });
  b.review('testing', false, 'The plan does not say which devices we test on, and our users skew to older Android phones. It also has no sandbox purchase cases.', [
    'Every bug report and test result names the story id and the build number (CONV-STORY-AND-BUILD-IN-REPORTS).',
  ]);

  // -------------------------------------------------------------------------
  // Change 4: EU first
  // -------------------------------------------------------------------------
  b.human(
    'One more change, and an important one (CHANGE-EU-FIRST): we launch in the EU first instead of the US. Launch countries are Germany, the Netherlands, Ireland and France, prices are in euros including VAT, all data must stay in the EU, and people must be able to export and delete their data. @ops please own the privacy side.',
    ['ops'],
  );
  b.fact('change-eu-first', 'CHANGE-EU-FIRST', ['*']);
  b.replan({
    workstreams: [
      ...b.currentPlan.workstreams.filter(w => w.id !== 'testing'),
      {
        id: 'privacy',
        title: 'EU privacy and data residency',
        brief: 'Keep all personal data in eu-west-1, build data export and account deletion, and write the records of processing for the EU launch.',
        owner: 'ops',
        dependsOn: ['backend'],
      },
      { ...W.testing, dependsOn: ['backend', 'web', 'mobile', 'sharing', 'billing', 'offline', 'privacy'] },
      {
        id: 'launch',
        title: 'Launch kit',
        brief: 'Prepare the store listings, help centre articles and release notes for the EU launch in four languages.',
        owner: 'analyst',
        dependsOn: ['testing'],
      },
    ],
    contracts: [
      ...b.currentPlan.contracts,
      {
        id: 'c-privacy-web',
        from: 'privacy',
        to: 'web',
        spec: 'POST /v1/me/export starts an export; the user gets a link to a ZIP of JSON files by email, at most 30 days later (CONTRACT-EXPORT-ZIP-30D). POST /v1/me/delete deletes the account after a 14-day grace period; signing in during the grace period cancels it.',
      },
    ],
  });
  b.fact('contract-export-zip-30d', 'CONTRACT-EXPORT-ZIP-30D', ['ops', 'web', 'qa']);
  b.deliver('analyst', 'requirements', {
    reply: 'Updated the requirements for the EU launch.',
    summary: 'EU launch countries, euro prices, export and deletion',
    add: [
      'EU launch: Germany, the Netherlands, Ireland and France; Larder Plus costs EUR 4.99 a month including VAT. LR-06 becomes account deletion with a 14-day grace period and LR-11 is data export as a ZIP of JSON files within 30 days. All personal data stays in eu-west-1.',
    ],
  });
  b.review('requirements', true, 'Approved; final version for launch.');
  b.ask('ops', 'privacy', 'backend', {
    reply: 'Writing the records of processing.',
    question: 'which tables and services hold personal data today, including logs and the import worker?',
  });
  b.answer('backend', 'backend', 'ops', 'accounts (email), memberships and invites (household links), recipes and list items (free text users type), request logs (IP addresses, kept 30 days) and the import worker (URLs only, not stored). Nothing else.');
  b.work('ops', 'infra', 'Moving everything to eu-west-1 before launch.', [
    op.decide(
      'Run production and all backups in eu-west-1 (Ireland) only; staging moves too so it matches production.',
      'The EU launch requires data residency in the EU, and one region keeps latency low for all four launch countries.',
      ['Keep us-east-1 and add an EU replica'],
      ['infra', 'privacy'],
    ),
  ]);
  b.deliver('ops', 'infra', {
    reply: 'Infrastructure moved to eu-west-1.',
    summary: 'Production, staging and backups in eu-west-1',
    add: [
      'Region: production and staging now run in eu-west-1 (Ireland); Postgres snapshots and the export bucket are in the same region and encrypted with a KMS key that never leaves it. The us-east-1 resources are deleted. Cutover took 12 minutes of read-only time.',
    ],
  });
  b.review('infra', true, 'Approved.');
  progress('ops', 'privacy', 'a dry run of the deletion job on a copy of production data', 'the export job and its email template');
  b.deliver('ops', 'privacy', {
    reply: 'First version of the privacy work.',
    summary: 'Records of processing, export and deletion jobs, eu-west-1',
    add: [
      'Records of processing list each personal data store (accounts, memberships, invites, recipes, list items, request logs) with purpose, legal basis and retention. Request logs keep IP addresses for 30 days.',
      'Export: POST /v1/me/export queues a job that writes a ZIP of JSON files (account, household, recipes, plans, lists) to an eu-west-1 bucket and emails a link valid for 7 days; median job time 40 seconds. Deletion: POST /v1/me/delete deletes after a 14-day grace period.',
    ],
  });
  b.review('privacy', true, 'Approved.');
  b.deliver('backend', 'backend', {
    reply: 'Backend changes for the EU launch.',
    summary: 'Export and deletion endpoints, euro prices',
    add: [
      'EU launch: POST /v1/me/export and POST /v1/me/delete call the privacy jobs; deleting the last owner of a household hands ownership to the longest-standing member. Entitlements show prices in EUR including VAT from the store data.',
    ],
  });
  b.review('backend', true, 'Approved.');
  b.ask('web', 'web', 'design', {
    reply: 'Translating the web app into German, Dutch and French.',
    question: 'German labels overflow the planner chips; may I wrap them to two lines, or do you want shorter strings?',
  });
  b.answer('design', 'ux', 'web', 'Wrap to two lines and keep the chip height flexible; I have asked the translator for shorter strings for the five longest labels.');
  b.deliver('web', 'web', {
    reply: 'Added the privacy page, the two-column list and the translations to the web app.',
    summary: 'Export and delete my data, two-column list, four languages',
    add: [
      'Privacy: settings has "Export my data" and "Delete my account", with the 14-day grace period explained and a banner to cancel deletion during it. Only essential cookies are set, so there is no cookie banner.',
      'Also in this version: the grocery list uses two columns split by aisle on screens wider than 1024 px, and the app is translated into German, Dutch and French; long German labels wrap to two lines in the planner chips.',
    ],
  });
  b.review('web', true, 'Approved.');
  b.deliver('mobile', 'mobile', {
    reply: 'Mobile changes for the EU launch.',
    summary: 'In-app account deletion, data export, four languages, euro prices',
    add: [
      'EU launch: account deletion is available inside the app (App Store guideline 5.1.1(v)) with the 14-day grace period, and data export is requested from settings. The app is translated into German, Dutch and French; prices come from the store in EUR including VAT.',
    ],
  });
  b.review('mobile', true, 'Approved.');
  b.work('ops', 'infra', 'Setting up the release for the launch.', [
    op.notes('infra: phased release on the App Store (7 days), staged rollout on Play 10% -> 50% -> 100%; API deploy freeze from Friday.'),
    op.message('Release plan: App Store phased release over 7 days, Play staged rollout 10%, 50%, 100%, and an API deploy freeze from Friday before launch.', 'inform'),
  ]);
  progress('analyst', 'launch', 'the store listing copy in English and German', 'the Dutch and French listings and the help centre articles');
  b.ask('analyst', 'launch', 'design', {
    reply: 'Preparing the store screenshots.',
    question: 'can you export the five listing screenshots (planner, shared list, offline banner, household, recipe import) in the four languages?',
  });
  b.answer('design', 'ux', 'analyst', 'Done: twenty screenshots for 6.7-inch iPhone and Android phones are in the launch folder, named by language and screen.');
  b.ask('analyst', 'launch', 'qa', {
    reply: 'Starting the release notes.',
    question: 'which known issues will still be open at launch, so I can list them honestly in the release notes?',
  });
  b.answer('qa', 'testing', 'analyst', 'Two minor ones so far: recipe import misses ingredient groups on some French sites, and the Android widget does not show household avatars. Both are logged with story ids.');
  b.deliver('qa', 'testing', {
    reply: 'Added the device matrix, sandbox purchases and EU cases to the plan.',
    summary: 'Device matrix, sandbox billing, offline and EU cases; release pass',
    add: [
      'Device matrix: iPhone SE (2nd gen) on iOS 17, iPhone 15 on iOS 18, Pixel 4a on Android 12, Samsung Galaxy A14 on Android 13 and a Redmi 9 on Android 10; web on current Chrome, Safari and Firefox.',
      'New cases: sandbox purchases and restores on both stores, household invites, the offline queue (Detox with setNetworkMode), export and deletion, and euro prices in all four launch countries.',
      'Release pass on build 498: 97 of 98 automated cases pass; the remaining one is LR-02 on two French recipe sites, logged as LR-02 / build 498 and accepted as a known issue.',
    ],
  });
  b.review('testing', true, 'Approved for release.');
  b.deliver('analyst', 'launch', {
    reply: 'Launch kit is ready.',
    summary: 'Store listings in four languages, help centre, release notes',
    add: [
      'Store listings in English, German, Dutch and French with screenshots of the planner, the shared list and the offline banner; Larder Plus at EUR 4.99 a month including VAT.',
      'Help centre: 12 articles (households and invites, offline shopping, restoring purchases, exporting and deleting data). Release notes list the two known issues: recipe import on some French sites (LR-02) and missing avatars in the Android widget.',
    ],
  });
  b.review('launch', true, 'Approved. Ready for the owner.');
  b.human('This is great work. We go live in the four countries on Monday. Thank you all.');

  return b.build();
}
