// xlong-product (spec 2026-11-04-xlong-scenario §2): Quire, a collaborative documents SaaS for small
// and mid-size teams, taken through six release cycles by eight bots: 3.1 accounts, 3.2 billing,
// 3.3 collaboration, 3.4 offline, 3.5 export and 3.6 compliance. Each cycle starts with a replan that
// closes the delivered workstreams of the previous cycle and adds new ones (new documents); inside a
// cycle the owner changes the requirements (followed by a replan that reflects the change), reviews
// fail and add conventions, bots ask each other questions and record failed approaches. Conventions
// and contracts from early cycles (error envelope, UTC timestamps, idempotency keys, session tokens,
// entitlements, the Yjs sync contract, ...) are restated with their markers in later cycles, where
// the work depends on them. Deliverables grow version by version: each new version keeps the earlier
// text and adds what changed.
import type { PlanInput } from '@context-continue/core';
import type { Scenario } from '../types.js';
import { LongScenarioBuilder, op, rotate, type Restatements } from './long.js';

type Ws = PlanInput['workstreams'][number];
type Contract = PlanInput['contracts'][number];

const EMPLOYEES: Scenario['employees'] = [
  { botId: 'pm', persona: 'Product lead who splits each release into workstreams, reviews every deliverable and keeps the plan consistent with what the owner wants.', skills: ['planning', 'review', 'release management'] },
  { botId: 'analyst', persona: 'Product analyst who writes requirements, prices plans, prepares compliance evidence and release notes.', skills: ['requirements', 'pricing', 'technical writing'] },
  { botId: 'design', persona: 'Product designer who designs flows, screens and the shared UI kit, and runs usability tests.', skills: ['interaction design', 'UI kit', 'accessibility'] },
  { botId: 'backend', persona: 'Backend engineer who designs the API and builds the services, the sync server and the export engine.', skills: ['Go', 'Postgres', 'API design', 'CRDTs'] },
  { botId: 'web', persona: 'Frontend engineer who builds the web app and its editor.', skills: ['React', 'TypeScript', 'service workers', 'accessibility'] },
  { botId: 'mobile', persona: 'Mobile engineer who builds the iOS and Android apps in React Native.', skills: ['React Native', 'SQLite', 'push notifications'] },
  { botId: 'qa', persona: 'Test engineer who writes test plans, automates end-to-end tests and runs release passes.', skills: ['test planning', 'Playwright', 'Detox', 'load testing'] },
  { botId: 'ops', persona: 'Platform and security engineer who runs infrastructure, CI/CD, security reviews and the compliance controls.', skills: ['AWS', 'Terraform', 'security', 'SOC 2'] },
];

/** R-L11: phrases that restate each fact; the builder cites the fact's marker wherever they appear later. */
export const XLONG_PRODUCT_RESTATEMENTS: Restatements = {
  // cycle 1: accounts
  'conv-iso8601-utc': ['ISO 8601', 'UTC with a Z'],
  'contract-error-envelope': ['{code, message, requestId}', 'error envelope'],
  'change-saml-sso': ['SAML'],
  'contract-session-tokens': ['refresh token', 'access token'],
  'fail-sms-otp': ['SMS code', 'SMS one-time'],
  'conv-wcag-22-aa': ['WCAG'],
  'conv-idempotency-key': ['Idempotency-Key', 'idempotency key'],
  'change-admin-2fa': ['two-factor', 'passkey'],
  'conv-server-role-check': ['role matrix', 'server-side role check'],
  'conv-story-and-build': ['story id and build', 'story id and the build'],
  // cycle 2: billing
  'contract-entitlements': ['/entitlements', 'entitlements endpoint', 'entitlements response'],
  'conv-money-minor-units': ['minor units'],
  'change-per-seat-pricing': ['per seat', 'per-seat'],
  'fail-nightly-proration': ['nightly proration'],
  'conv-webhooks-verified': ['Stripe-Signature', 'webhook signature'],
  'contract-dunning-states': ['past_due', 'read_only'],
  'change-vat-reverse-charge': ['reverse charge', 'reverse-charge', 'VIES'],
  'fail-cached-seat-count': ['cached seat count', 'seat count cache'],
  // cycle 3: collaboration
  'fail-ot-server': ['operational transform'],
  'contract-yjs-sync': ['Yjs'],
  'change-suggestion-mode': ['suggestion mode', 'live cursors on mobile'],
  'conv-presence-ttl': ['heartbeat'],
  'contract-doc-roles': ['viewer, commenter', 'commenter role'],
  'conv-mention-digest': ['digest'],
  'fail-sticky-sessions': ['sticky session'],
  // cycle 4: offline
  'change-offline-editing': ['offline editing', 'edit offline'],
  'change-pwa-not-desktop': ['Electron', 'installable web app'],
  'contract-state-vector-resync': ['state vector'],
  'fail-localstorage-quota': ['localStorage'],
  'conv-offline-pin-limit': ['50 pinned', 'pin limit'],
  'fail-ios-background-fetch': ['background fetch', 'BGAppRefresh'],
  'conv-sync-state-visible': ['sync state'],
  // cycle 5: export
  'contract-export-jobs': ['/v2/exports', 'export job'],
  'fail-pdf-in-api': ['inside the API process'],
  'change-docx-export': ['DOCX'],
  'conv-golden-files': ['golden file'],
  'change-workspace-export': ['workspace export'],
  'conv-export-filenames': ['file name pattern', 'ASCII-safe'],
  'fail-pandoc-docx': ['pandoc', 'Pandoc'],
  // cycle 6: compliance
  'change-soc2-type2': ['SOC 2'],
  'change-eu-residency': ['eu-central-1', 'Frankfurt'],
  'contract-audit-events': ['audit event'],
  'fail-us-read-replica': ['us-east-1 read replica', 'cross-region replica'],
  'conv-access-review': ['access review'],
  'conv-change-ticket': ['change ticket'],
};

/** Routine progress replies, rotated so consecutive updates do not read the same. */
const PROGRESS: ((done: string, next: string) => string)[] = [
  (d, n) => `Done with ${d}. Next I am on ${n}.`,
  (d, n) => `Finished and checked locally: ${d}. Moving on to ${n}.`,
  (d, n) => `Progress update: completed ${d}. Now starting ${n}.`,
  (d, n) => `Finished ${d} this morning. Next up: ${n}.`,
  (d, n) => `Wrapped up ${d}; next on my list is ${n}.`,
  (d, n) => `Done and pushed for review: ${d}. Now on ${n}.`,
  (d, n) => `Closed out ${d}. Continuing with ${n}.`,
  (d, n) => `Landed on main today: ${d}. Picking up ${n}.`,
];

/** The helpers every cycle uses; they wrap the builder so each cycle reads as a script. */
interface Ctx {
  b: LongScenarioBuilder;
  /** Sets the ordered task list of a workstream; `tick` walks it. */
  tasks(ws: string, list: string[]): void;
  /** One progress step per workstream: the owner reports the current task done and names the next. */
  tick(...ws: string[]): void;
  /** The owner starts a workstream: a reply, a look at its board item and a pinned private note. */
  start(ws: string, reply: string, note: string, lookup?: string): void;
  /** The owner submits the next version of the deliverable. */
  dv(ws: string, reply: string, summary: string, ...add: string[]): void;
  /** The lead reviews the latest version. */
  rev(ws: string, passed: boolean, notes: string, conventions?: string[]): void;
  /** A question and its answer: `from` (on `ws`) asks `to`, who answers while working on `toWs`. */
  qa(a: { from: string; ws: string; to: string; toWs: string; reply: string; q: string; a: string; also?: string[] }): void;
  /** A status round: the owner asks, then each listed workstream's owner posts one status message. */
  status(ask: string, wss: string[]): void;
  /** The lead records an agreement between bots as a contract: a replan that adds or replaces contracts. */
  record(...contracts: Contract[]): void;
  /** Checks that every task list of the cycle was walked (at most the last "next" task left over). */
  close(prefix: string): void;
  owner(ws: string): string;
}

function makeCtx(b: LongScenarioBuilder): Ctx {
  const queues = new Map<string, { tasks: string[]; i: number }>();
  const lastReview = new Map<string, boolean>();
  const posted = new Set<string>();
  let turn = 0;
  const owner = (ws: string): string => {
    const w = b.currentPlan.workstreams.find(x => x.id === ws);
    if (!w) throw new Error(`step ${b.length}: workstream "${ws}" is not in the current plan`);
    return w.owner;
  };
  const title = (ws: string): string => b.currentPlan.workstreams.find(x => x.id === ws)!.title;
  return {
    b,
    owner,
    tasks(ws, list) {
      if (queues.has(ws)) throw new Error(`tasks for ${ws} set twice`);
      queues.set(ws, { tasks: list, i: 0 });
    },
    tick(...wss) {
      for (const ws of wss) {
        const q = queues.get(ws);
        if (!q) throw new Error(`step ${b.length}: no tasks for ${ws}`);
        const done = q.tasks[q.i];
        const next = q.tasks[q.i + 1];
        if (done === undefined || next === undefined) throw new Error(`step ${b.length}: ${ws} has run out of tasks`);
        b.work(owner(ws), ws, rotate(PROGRESS, turn++)(done, next), [op.notes(`${ws}: done ${done}; next ${next}.`)]);
        q.i++;
      }
    },
    start(ws, reply, note, lookup) {
      b.work(owner(ws), ws, reply, [op.board(lookup ?? ws), op.notes(note, true)]);
    },
    dv(ws, reply, summary, ...add) {
      b.deliver(owner(ws), ws, { reply, summary, add });
    },
    rev(ws, passed, notes, conventions) {
      b.review(ws, passed, notes, conventions);
      lastReview.set(ws, passed);
    },
    qa({ from, ws, to, toWs, reply, q, a, also }) {
      b.ask(from, ws, to, { reply, question: q });
      b.answer(to, toWs, from, a, [], also ?? []);
    },
    status(ask, wss) {
      b.human(ask);
      for (const ws of wss) {
        const v = b.version(ws);
        const state = v === 0 ? 'no version submitted yet' : `version ${v} ${lastReview.get(ws) === true ? 'approved' : lastReview.get(ws) === false ? 'sent back with review notes' : 'waiting for review'}`;
        const q = queues.get(ws);
        const doing = q && q.tasks[q.i] !== undefined ? `; now on ${q.tasks[q.i]}` : '';
        const last = q && q.i > 0 ? `; last finished ${q.tasks[q.i - 1]}` : '';
        // The reply is the message itself, so it is posted once (R-L14, R-L9).
        const message = `Status for the week: ${title(ws)}: ${state}${last}${doing}.`;
        // Nothing changed since the last status: the owner has nothing new to post.
        if (posted.has(message)) continue;
        posted.add(message);
        b.work(owner(ws), ws, message, [op.message(message, 'inform')]);
      }
    },
    record(...contracts) {
      const ids = new Set(contracts.map(c => c.id));
      b.replan({ workstreams: b.currentPlan.workstreams, contracts: [...b.currentPlan.contracts.filter(c => !ids.has(c.id)), ...contracts] });
    },
    close(prefix) {
      const problems: string[] = [];
      for (const [ws, q] of queues) {
        // A workstream the plan dropped before it was delivered has nothing left to do.
        if (!ws.startsWith(prefix) || !b.currentPlan.workstreams.some(w => w.id === ws)) continue;
        if (q.i < q.tasks.length - 1) problems.push(`${ws} has ${q.tasks.length - 1 - q.i} unused tasks`);
        if (lastReview.get(ws) !== true) problems.push(`${ws} ends without a passed review`);
      }
      if (problems.length > 0) throw new Error(`step ${b.length}, cycle ${prefix}: ${problems.join('; ')}`);
    },
  };
}

export function generateXlongProduct(): Scenario {
  const b = new LongScenarioBuilder({
    id: 'xlong-product',
    tier: 'xlong',
    goal: 'Take Quire, a collaborative documents app for small and mid-size teams (web, iOS and Android), through six releases: 3.1 accounts, 3.2 billing, 3.3 collaboration, 3.4 offline, 3.5 export and 3.6 compliance.',
    constraints: [
      'Each release ships within six weeks with the same eight-person team.',
      'Existing documents, links and integrations keep working across every release.',
      'Personal data is collected and kept only where a feature needs it.',
    ],
    owner: 'maya',
    lead: 'pm',
    employees: EMPLOYEES,
    restatements: XLONG_PRODUCT_RESTATEMENTS,
    plan: { workstreams: Object.values(ACCT_WS), contracts: Object.values(ACCT_C) },
  });
  const x = makeCtx(b);
  cycleAccounts(x);
  cycleBilling(x);
  cycleCollaboration(x);
  cycleOffline(x);
  cycleExport(x);
  cycleCompliance(x);
  return b.build();
}

// ===========================================================================
// Cycle 1: accounts (Quire 3.1)
// ===========================================================================

const ACCT_WS = {
  req: { id: 'acct-req', title: 'Accounts requirements', brief: 'Write the requirements for Quire 3.1 accounts: workspaces, the owner/admin/member/guest roles, sign-in methods, invitations and account deletion, as numbered stories with acceptance criteria.', owner: 'analyst', dependsOn: [] },
  ux: { id: 'acct-ux', title: 'Sign-in and workspace UX', brief: 'Design sign-in, sign-up, the workspace switcher, member management and invitation flows for the web and mobile apps.', owner: 'design', dependsOn: ['acct-req'] },
  api: { id: 'acct-api', title: 'Identity service and API', brief: 'Build the identity service: accounts, workspaces, memberships, invitations and sessions, with an OpenAPI 3.1 document for /v2/auth and /v2/workspaces.', owner: 'backend', dependsOn: ['acct-req'] },
  web: { id: 'acct-web', title: 'Web sign-in and workspace settings', brief: 'Build sign-in, sign-up, the workspace switcher and the members page in the web app against the identity API.', owner: 'web', dependsOn: ['acct-ux', 'acct-api'] },
  mobile: { id: 'acct-mobile', title: 'Mobile sign-in and account screens', brief: 'Build sign-in, the workspace switcher and the account screens in the iOS and Android apps.', owner: 'mobile', dependsOn: ['acct-ux', 'acct-api'] },
  sec: { id: 'acct-sec', title: 'Account security review', brief: 'Threat-model sign-in, sessions and invitations, choose the second factor, and list the fixes required before 3.1 ships.', owner: 'ops', dependsOn: ['acct-api'] },
  tests: { id: 'acct-tests', title: 'Accounts test plan and release pass', brief: 'Write the 3.1 test plan from the stories, automate sign-in and invitation paths and run the release pass.', owner: 'qa', dependsOn: ['acct-web', 'acct-mobile'] },
} satisfies Record<string, Ws>;

const ACCT_C = {
  reqTests: { id: 'c-acct-req-tests', from: 'acct-req', to: 'acct-tests', spec: 'Stories are numbered ACC-nn and each has a checklist of acceptance criteria that the test plan traces one to one.' },
  apiWeb: { id: 'c-acct-api-web', from: 'acct-api', to: 'acct-web', spec: 'OpenAPI 3.1 document for /v2/auth and /v2/workspaces, JSON over HTTPS with bearer tokens; the web client is generated from it.' },
  apiMobile: { id: 'c-acct-api-mobile', from: 'acct-api', to: 'acct-mobile', spec: 'The same OpenAPI document; the mobile client is generated from it and a breaking change needs a new major API version.' },
  uxWeb: { id: 'c-acct-ux-web', from: 'acct-ux', to: 'acct-web', spec: 'Figma frames that use the Quire UI kit component names; design tokens exported as JSON for web and mobile.' },
} satisfies Record<string, Contract>;

function cycleAccounts(x: Ctx): void {
  const { b } = x;
  x.tasks('acct-req', [
    'the interview notes from the twelve teams that asked for shared workspaces',
    'the role table for owner, admin, member and guest',
    'the stories for creating and switching workspaces',
    'the invitation stories, including expired and revoked links',
    'acceptance checklists for ACC-01 to ACC-06',
    'the account deletion story and what happens to documents a leaving member owns',
    'the guest limits per workspace',
    'the stories for the enterprise sign-in path',
    'the admin security stories',
    'the non-goals section (no nested workspaces, no per-folder roles yet)',
    'a pass over every story with the support team\'s top ten tickets',
    'the glossary so that workspace, team and organisation stop meaning three things',
    'the migration story for the 31,000 existing single-user accounts',
    'the final consistency pass before sign-off',
  ]);
  x.tasks('acct-ux', [
    'an inventory of the current sign-in screens on web, iOS and Android',
    'the sign-in screen with email link and Google',
    'the workspace switcher in the sidebar',
    'the members page with role chips',
    'the invitation sheet and the accept-invite landing page',
    'the empty states for a new workspace',
    'the error states for expired invitations',
    'the enterprise sign-in entry on the sign-in screen',
    'the second-factor enrolment flow',
    'the mobile account screen',
    'a usability test of the switcher with six people',
    'the leave-workspace and delete-account confirmations',
    'the redlines for web and mobile engineers',
    'the hand-off notes for QA',
  ]);
  x.tasks('acct-api', [
    'the Postgres schema for accounts, workspaces and memberships',
    'the migration that wraps every existing account in a personal workspace',
    'POST /v2/auth/email-link and the link verification',
    'Google sign-in with PKCE',
    'the invitation endpoints and their hashed tokens',
    'membership role changes and the last-owner guard',
    'the session table and token rotation',
    'the OpenAPI document generation in CI',
    'rate limits on sign-in and invitation endpoints',
    'the account deletion job with a 14-day grace period',
    'load tests for sign-in at 300 requests per second',
    'the audit trail rows for role changes',
    'the SAML assertion consumer endpoint',
    'the TOTP and WebAuthn verification endpoints',
    'the final API document for clients',
  ]);
  x.tasks('acct-web', [
    'regenerating the API client from the /v2 document',
    'the sign-in route with email link and Google',
    'the workspace switcher component in the web sidebar',
    'the members page table with role menus',
    'the invitation dialog and copy-link button',
    'the accept-invite route for signed-out visitors',
    'error handling that shows the server message with a retry',
    'keyboard navigation in the switcher',
    'the enterprise sign-in redirect',
    'the second-factor prompt after password-less sign-in',
    'the delete-account page',
    'route-level code splitting for the settings pages',
    'Playwright smoke tests for sign-in',
    'the last visual pass against the redlines',
  ]);
  x.tasks('acct-mobile', [
    'regenerating the mobile API client from the /v2 document',
    'the mobile sign-in screen with email link and Google',
    'universal links and app links for email sign-in',
    'secure token storage in Keychain and Keystore',
    'the workspace switcher drawer',
    'the account screen with sign-out everywhere',
    'accepting an invitation from a link on the phone',
    'the enterprise sign-in in an in-app browser session',
    'the second-factor screen',
    'push token registration per workspace',
    'the delete-account screen required by both stores',
    'Detox flows for sign-in and invitations',
    'a pass on small screens (iPhone SE, 360 dp Android)',
    'release builds 3.1.0 for TestFlight and the Play internal track, with the new sign-in screens in the store screenshots',
  ]);
  x.tasks('acct-sec', [
    'the STRIDE model for sign-in links and sessions',
    'a review of how invitation tokens are stored',
    'brute-force limits for the sign-in endpoints',
    'the session revocation path when a member is removed',
    'a review of the Google sign-in redirect URIs',
    'the comparison of second-factor options',
    'a check of cookie flags on the web session',
    'the SAML signature and clock-skew checks',
    'secret storage for the identity provider certificates',
    'dependency scanning in CI for the identity service',
    'the admin enforcement rules for the second factor',
    'the penetration test scope for 3.1',
    'the fix list for 3.1',
    'the sign-off note for the release',
  ]);
  x.tasks('acct-tests', [
    'tracing ACC-01 to ACC-06 to test cases',
    'the staging seed with workspaces of 1, 5 and 40 members',
    'Playwright cases for sign-in and the switcher',
    'Detox cases for sign-in on both platforms',
    'invitation cases for expired, revoked and reused links',
    'role cases for every row of the role table',
    'the enterprise sign-in cases against a test Okta tenant',
    'second-factor cases including lost devices',
    'the device matrix for 3.1',
    'account deletion cases with the grace period',
    'the regression run on the existing editor flows',
    'the release pass on build 3.1.0-rc2',
    'the known-issues list for 3.1, so far only the English-only Okta error page',
    'the 3.1 sign-off notes for the owner',
  ]);

  b.human(
    'Hi team. Quire 3.1 is about accounts: teams keep asking for shared workspaces with proper roles instead of everyone sharing one login. @pm please get the requirements going; I want 3.1 out in six weeks, and the five releases after it follow the same rhythm.',
    ['pm'],
  );
  x.start('acct-req', 'Starting the 3.1 requirements: roles first, then workspaces and invitations.', 'acct-req: interview notes from 12 teams; role table; stories numbered ACC-nn with checklists.');
  x.start('acct-api', 'Starting the identity service. First the data model, so the migration of existing accounts is clear early.', 'acct-api: accounts, workspaces, memberships(role), invitations(token hash), sessions; Go service on Postgres 16.');
  x.start('acct-sec', 'Starting the account security review with the threat model for sign-in links and sessions.', 'acct-sec: STRIDE on email links, Google sign-in, sessions, invitations; second factor later.', 'acct-api');
  x.tick('acct-req', 'acct-api');
  x.qa({
    from: 'analyst', ws: 'acct-req', to: 'design', toWs: 'acct-ux',
    reply: 'Writing the role table.',
    q: 'in your research sessions, did anyone ask for guests who can see only one document, or is a guest always a whole-workspace reader?',
    a: 'Four of the twelve teams invite agencies and want them to see a single folder, never the whole workspace. Nobody asked for single-document guests. A guest that sees chosen folders covers all four.',
  });
  x.tick('acct-req', 'acct-sec');
  x.start('acct-ux', 'Starting the sign-in and workspace flows from the current screens.', 'acct-ux: inventory first; switcher in sidebar; members page; invite sheet; mobile account screen.', 'acct-req');
  x.tick('acct-api', 'acct-ux', 'acct-req');
  x.dv('acct-req', 'First version of the 3.1 requirements: roles, workspaces and invitations.', 'Roles, workspaces and invitations; stories ACC-01 to ACC-06',
    'Roles: owner (billing and deletion of the workspace), admin (members and settings), member (create and edit documents) and guest (reads and comments in the folders shared with them). A workspace has at least one owner at all times; a guest never sees the member list.',
    'Stories: ACC-01 create a workspace; ACC-02 switch between workspaces; ACC-03 invite by email; ACC-04 accept an invitation; ACC-05 change a member\'s role; ACC-06 leave a workspace. Existing accounts become the owner of a personal workspace holding their documents.',
  );
  x.rev('acct-req', false, 'The roles are clear, but the stories have no acceptance criteria and invitations say nothing about expiry or revocation. QA cannot test this. Add checklists and the invitation lifecycle.');
  x.tick('acct-req', 'acct-api');
  x.dv('acct-req', 'Added acceptance checklists and the invitation lifecycle.', 'Checklists for ACC-01 to ACC-06; invitation expiry and revocation',
    'Acceptance checklists: ACC-03 an invitation email arrives within one minute, the link works once and expires after 7 days; an admin can revoke it and the link then shows "This invitation was withdrawn". ACC-05 only owners can make someone an owner; the last owner cannot be demoted. ACC-06 a member who leaves keeps nothing; their documents stay in the workspace under the original author name.',
  );
  x.rev('acct-req', true, 'Testable now. Approved as the baseline for 3.1.');
  x.start('acct-web', 'Starting the web side of accounts from the approved stories.', 'acct-web: regenerate client from /v2; routes /signin, /w/:slug, /settings/members.', 'c-acct-api-web');
  x.start('acct-mobile', 'Starting the mobile account screens: client generation and token storage first.', 'acct-mobile: regenerate client; Keychain/Keystore; universal links for email sign-in.', 'c-acct-api-mobile');
  x.start('acct-tests', 'Starting the 3.1 test plan by tracing the approved stories.', 'acct-tests: trace ACC-nn; seed workspaces of 1, 5 and 40 members; Playwright + Detox.', 'c-acct-req-tests');
  x.tick('acct-api', 'acct-ux', 'acct-sec');
  x.dv('acct-api', 'First draft of the identity API is ready for review.', 'Accounts, workspaces, memberships and invitations in /v2',
    'Resources: /v2/auth/email-link, /v2/auth/google, /v2/workspaces, /v2/workspaces/{id}/members and /v2/workspaces/{id}/invitations. Invitation tokens are 32 random bytes, stored as SHA-256 hashes and valid for 7 days. JSON over HTTPS with bearer tokens.',
    'Dates and times: created and expiry times are returned as the server\'s local time strings, for example "2026-11-04 14:05", and list endpoints return everything in one response.',
  );
  x.rev('acct-api', false, 'Local time strings will break as soon as a workspace has members in two time zones, and members lists of large workspaces need paging. Fix both before the clients generate from this.', [
    'Every timestamp in the API, in events and in exported files is ISO 8601 in UTC with a Z suffix; calendar days are plain YYYY-MM-DD (CONV-ISO8601-UTC).',
  ]);
  b.fact('conv-iso8601-utc', 'CONV-ISO8601-UTC', ['backend', 'web', 'mobile', 'analyst'], {
    question: 'What time format must every timestamp in the API, in events and in exported files use?',
    expect: ['ISO 8601', 'UTC'],
  });
  x.tick('acct-web', 'acct-mobile', 'acct-api', 'acct-sec');
  x.qa({
    from: 'web', ws: 'acct-web', to: 'backend', toWs: 'acct-api',
    reply: 'Wiring error handling into the generated web client.',
    q: 'what does an error response look like, so the client can show the server message and decide when to retry?',
    a: 'Every error is {code, message, requestId} with a 4xx or 5xx status (CONTRACT-ERROR-ENVELOPE): code is a stable string such as INVITATION_EXPIRED, message is safe to show to the user, requestId is what support asks for, and a 429 or 503 carries Retry-After. @mobile the same holds for you, and I will put it in the API document.',
    also: ['mobile'],
  });
  b.fact('contract-error-envelope', 'CONTRACT-ERROR-ENVELOPE', ['web', 'mobile', 'qa', 'backend'], {
    question: 'Which fields must every API error body carry?',
    expect: ['requestId'],
  });
  x.dv('acct-api', 'Revised the identity API: UTC timestamps, paging, and the error format.', 'UTC timestamps, cursor paging on members, error format',
    'Revision after review: every timestamp is ISO 8601 in UTC with a Z suffix; members and invitations use cursor paging (cursor and limit, at most 100). Errors use the {code, message, requestId} body with stable codes such as INVITATION_EXPIRED and LAST_OWNER.',
  );
  x.rev('acct-api', true, 'Approved. Web and mobile can generate their clients from this version.');
  x.tick('acct-ux', 'acct-tests', 'acct-sec', 'acct-web', 'acct-api');
  x.dv('acct-ux', 'First version of the sign-in and workspace flows.', 'Sign-in, switcher, members page and invitation flows',
    'Sign-in: one screen with an email field (we send a sign-in link) and "Continue with Google". The workspace switcher sits at the top of the sidebar with the workspace icon and name; keyboard shortcut Cmd+K then the workspace name.',
    'Members page: a table with name, email, role chip and last active date; admins change roles from a menu on the chip. Invitations: a sheet with several emails, a role picker and a copy-link button; pending invitations are listed with Resend and Withdraw.',
  );
  x.rev('acct-ux', false, 'The role chips are pale grey on white (about 2.1:1) and the switcher items are 28 px high on touch screens. People will not be able to read or hit them. Fix contrast and target sizes across the kit, not only here.', [
    'Text and icons meet WCAG 2.2 AA contrast (4.5:1 for text, 3:1 for icons and chips) and touch targets are at least 44 by 44 points on every platform (CONV-WCAG-22-AA).',
  ]);
  b.fact('conv-wcag-22-aa', 'CONV-WCAG-22-AA', ['design', 'web', 'mobile', 'qa'], {
    question: 'What contrast ratio must text meet, and what is the minimum touch target size?',
    expect: ['WCAG 2.2 AA', '44 by 44', '4.5:1'],
  });
  x.tick('acct-req', 'acct-api', 'acct-mobile', 'acct-ux');
  x.dv('acct-ux', 'Fixed contrast and target sizes in the kit and in these flows.', 'Contrast and 44-point targets across the kit',
    'Accessibility: role chips now use slate-700 on slate-100 (7.2:1), switcher rows are 44 px on touch screens and 32 px only with a pointer, focus rings are 2 px indigo-600. Checked every screen of the flows against WCAG 2.2 AA.',
  );
  x.rev('acct-ux', true, 'Approved. Web and mobile can build against this.');

  x.tick('acct-web', 'acct-sec', 'acct-api', 'acct-req');

  // Change 1: enterprise sign-in
  b.human(
    'Change of requirements (CHANGE-SAML-SSO): the three enterprise trials we are closing all need SAML single sign-on with Okta and Azure AD, and their admins want to enforce it for the whole workspace, instead of the Google-only sign-in we planned. Please add it to 3.1 rather than waiting for a later release.',
  );
  b.fact('change-saml-sso', 'CHANGE-SAML-SSO', ['*'], {
    question: 'Which sign-in methods must workspace authentication support? Give only the current value.',
    expect: ['SAML', 'Okta'],
    reject: ['Google sign-in'],
  });
  b.replan({
    workstreams: [
      ACCT_WS.req,
      ACCT_WS.ux,
      { ...ACCT_WS.api, brief: 'Build the identity service: accounts, workspaces, memberships, invitations and sessions, with an OpenAPI 3.1 document for /v2/auth and /v2/workspaces. Enterprise SAML sign-in is a separate workstream that builds on it.' },
      ACCT_WS.web,
      ACCT_WS.mobile,
      ACCT_WS.sec,
      { id: 'acct-sso', title: 'Enterprise SAML single sign-on', brief: 'Add SAML 2.0 single sign-on per workspace (Okta and Azure AD first), domain verification and an admin switch that enforces it for every member.', owner: 'backend', dependsOn: ['acct-api'] },
      { ...ACCT_WS.tests, dependsOn: ['acct-web', 'acct-mobile', 'acct-sso'] },
    ],
    contracts: [
      ...Object.values(ACCT_C),
      { id: 'c-acct-sso-web', from: 'acct-sso', to: 'acct-web', spec: 'GET /v2/auth/sso/discover?email= returns the workspace\'s SAML sign-in URL or 404; after the identity provider posts back, the session is the same as any other sign-in: a 15-minute access token and a rotating refresh token valid for 30 days of inactivity (CONTRACT-SESSION-TOKENS).' },
      { id: 'c-acct-sso-mobile', from: 'acct-sso', to: 'acct-mobile', spec: 'The same discovery endpoint; the app opens the identity provider in an in-app browser session and receives the session tokens through the universal link; refresh tokens rotate on every use.' },
    ],
  });
  b.fact('contract-session-tokens', 'CONTRACT-SESSION-TOKENS', ['web', 'mobile', 'backend', 'ops'], {
    question: 'How long is a refresh token valid?',
    expect: ['30 days', 'rotating'],
  });
  x.tasks('acct-sso', [
    'the SAML library choice and its signature checks',
    'per-workspace identity provider settings',
    'domain verification with a DNS TXT record',
    'the discovery endpoint by email domain',
    'just-in-time membership for new SSO users',
    'the enforcement switch and its lock-out guard',
    'an Okta test tenant run',
    'an Azure AD test tenant run',
    'the admin documentation for both providers',
  ]);
  x.dv('acct-req', 'Added the enterprise sign-in stories.', 'SAML sign-in stories ACC-07 to ACC-09',
    'Enterprise sign-in: ACC-07 an admin connects Okta or Azure AD with the metadata URL and verifies the email domain; ACC-08 a member with a verified-domain email is sent to the identity provider; ACC-09 an admin enforces SAML for the workspace and every other sign-in method stops working for its members, except one break-glass owner account.',
  );
  x.rev('acct-req', true, 'Approved. This matches what the owner asked for.');
  x.start('acct-sso', 'Starting enterprise SAML sign-in on top of the identity service.', 'acct-sso: crewjam/saml; per-workspace IdP config; DNS TXT verification; enforce switch with break-glass owner.', 'c-acct-sso-web');
  x.tick('acct-sso', 'acct-web', 'acct-tests');
  x.qa({
    from: 'mobile', ws: 'acct-mobile', to: 'backend', toWs: 'acct-sso',
    reply: 'Planning the SAML path on the phone.',
    q: 'when the identity provider posts back, how does the app get its tokens: in the universal link itself, or through a one-time code it exchanges?',
    a: 'Through a one-time code: the universal link carries a 60-second code, the app exchanges it at POST /v2/auth/sso/exchange for the access token and refresh token. Tokens never appear in a URL.',
  });
  x.record({ id: 'c-acct-sso-mobile', from: 'acct-sso', to: 'acct-mobile', spec: 'The same discovery endpoint; the app opens the identity provider in an in-app browser session, receives a one-time code through the universal link and exchanges it within 60 seconds at POST /v2/auth/sso/exchange for the access token and the rotating refresh token. Tokens never appear in a URL.' });
  x.tick('acct-sec', 'acct-mobile', 'acct-sso');
  b.work('ops', 'acct-sec', 'Recording a failed approach (FAIL-SMS-OTP): SMS one-time codes as the second factor. In the pilot 9% of codes to Brazil and India arrived after they expired, and SIM-swap takeovers of two admin accounts at a customer last year started exactly this way. We will offer TOTP apps and passkeys only.', [
    op.failure(
      'SMS one-time codes as the second factor for Quire accounts (FAIL-SMS-OTP).',
      '9% of pilot codes to Brazil and India arrived after expiry, SMS costs grow with every sign-in, and SIM swapping defeats it; TOTP apps and passkeys have neither problem.',
      ['acct-sec'],
    ),
  ]);
  b.fact('fail-sms-otp', 'FAIL-SMS-OTP', ['ops', 'backend', 'mobile', 'web'], {
    question: 'Which second-factor method was recorded as a failed approach?',
    expect: ['SMS', 'one-time codes'],
  });
  x.tick('acct-ux', 'acct-req', 'acct-api', 'acct-ux');
  x.dv('acct-web', 'First version of the web sign-in and workspace settings.', 'Sign-in, switcher, members page and invitations on the web',
    'Routes /signin, /w/:slug and /w/:slug/settings/members; the client is generated from the /v2 document. Errors show the server message with a retry button when Retry-After is set, and the requestId is in the "copy details" link for support.',
    'Members page: role menus are shown only to admins and owners, and the "Remove" button is hidden for members; the invitation dialog accepts up to 20 emails at once and shows pending invitations with Resend and Withdraw.',
  );
  x.rev('acct-web', false, 'Hiding the buttons is not a permission check: I removed a member as a plain member by calling the endpoint from the console, and the API accepted it. Roles have to be enforced by the service on every request; the UI only mirrors them.', [
    'Permissions are enforced by a server-side role check on every request against one role matrix in the identity service; clients only hide what the role matrix forbids (CONV-SERVER-ROLE-CHECK).',
  ]);
  b.fact('conv-server-role-check', 'CONV-SERVER-ROLE-CHECK', ['backend', 'web', 'mobile', 'qa'], {
    question: 'Where must permissions be enforced?',
    expect: ['server-side'],
  });
  x.tick('acct-api', 'acct-web');
  x.dv('acct-api', 'Added the server-side role check and the session rules.', 'Role matrix enforced on every request; session rotation',
    'Permissions: one role matrix (owner, admin, member, guest by action) lives in the identity service and every handler checks it before doing anything; a plain member removing someone now gets 403 FORBIDDEN_ROLE. Sessions: 15-minute access tokens and refresh tokens that rotate on every use and expire after 30 days without use; reusing an old refresh token revokes the whole session family.',
  );
  x.rev('acct-api', false, 'The role matrix is right. But mobile retries on a flaky connection will create two invitations or two workspaces: POST is not safe to repeat. Fix that before clients ship.', [
    'Every POST accepts an Idempotency-Key header; the server keeps keys for 24 hours and a repeat returns the first response (CONV-IDEMPOTENCY-KEY).',
  ]);
  b.fact('conv-idempotency-key', 'CONV-IDEMPOTENCY-KEY', ['backend', 'web', 'mobile'], {
    question: 'Which request header must every POST accept, and how long does the server keep its values?',
    expect: ['Idempotency-Key', '24 hours'],
  });
  x.tick('acct-mobile', 'acct-tests', 'acct-sso');
  x.dv('acct-api', 'Added idempotency keys to every POST.', 'Idempotency-Key on every POST',
    'Idempotency: every POST accepts an Idempotency-Key header; keys live for 24 hours in Postgres and a repeat with the same key returns the stored response. With 30% packet loss on the staging proxy no duplicate invitation or workspace was created in 2,000 attempts.',
  );
  x.rev('acct-api', true, 'Approved. 2,000 retries without a duplicate is the evidence I wanted.');
  x.dv('acct-web', 'Moved permission handling to the API and kept the UI in step with it.', 'Server-enforced roles; 403 handling',
    'Permissions: the web app reads the role matrix from GET /v2/workspaces/{id}/me and only hides what it forbids; a 403 FORBIDDEN_ROLE from the server shows "You do not have permission to do this" and reloads the member list. POST requests send an Idempotency-Key generated per user action.',
  );
  x.rev('acct-web', true, 'Approved. The 403 message is clear and the member list recovers on its own.');
  x.tick('acct-ux', 'acct-sec', 'acct-web');
  x.qa({
    from: 'qa', ws: 'acct-tests', to: 'backend', toWs: 'acct-api',
    reply: 'Preparing the staging data for the 3.1 runs.',
    q: 'can staging seed three workspaces with 1, 5 and 40 members, one guest each, and reset every night?',
    a: 'Yes: make seed-accounts creates them with predictable emails (member-01@seed.quire.test and so on) and the nightly deploy runs it after migrations.',
  });
  x.tick('acct-tests', 'acct-sec', 'acct-ux');
  x.qa({
    from: 'design', ws: 'acct-ux', to: 'ops', toWs: 'acct-sec',
    reply: 'Designing the second-factor enrolment.',
    q: 'which second factors should the enrolment screen offer, and in what order?',
    a: 'Passkeys first, then an authenticator app with a QR code, and ten one-time recovery codes at the end. No SMS (FAIL-SMS-OTP).',
  });
  x.record({ id: 'c-acct-2fa-web', from: 'acct-sec', to: 'acct-web', spec: 'Second factors offered in this order: passkeys, an authenticator app with a QR code and a manual key, then ten one-time recovery codes shown once; never SMS (FAIL-SMS-OTP).' });
  x.tick('acct-sso', 'acct-mobile', 'acct-req', 'acct-web', 'acct-api', 'acct-ux');
  x.status('End of week two of 3.1. A short status from each of you, please.', ['acct-req', 'acct-ux', 'acct-api', 'acct-sso', 'acct-web', 'acct-mobile', 'acct-sec', 'acct-tests']);

  // Change 2: admins must use a second factor
  b.human(
    'Another change from the enterprise trials (CHANGE-ADMIN-2FA): two-factor authentication was going to be optional for everyone. Now workspace owners and admins must use it, with passkeys or an authenticator app; an admin without it gets read-only access until they enrol. Members can still opt in. This is part of 3.1.',
  );
  b.fact('change-admin-2fa', 'CHANGE-ADMIN-2FA', ['*'], {
    question: 'Who must use two-factor authentication, and what happens to an admin without it? Give only the current value.',
    expect: ['owners and admins', 'read-only'],
  });
  b.replan({
    workstreams: b.currentPlan.workstreams.map(w =>
      w.id === 'acct-sec'
        ? { ...w, brief: 'Threat-model sign-in, sessions and invitations, define the two-factor rules for owners and admins (passkeys or an authenticator app), and list the fixes required before 3.1 ships.' }
        : w.id === 'acct-mobile'
          ? { ...w, brief: 'Build sign-in, the workspace switcher, the account screens and two-factor enrolment with passkeys and authenticator apps in the iOS and Android apps.' }
          : w.id === 'acct-web'
            ? { ...w, brief: 'Build sign-in, sign-up, the workspace switcher, the members page and two-factor enrolment in the web app against the identity API.' }
            : w,
    ),
    contracts: b.currentPlan.contracts,
  });
  x.dv('acct-ux', 'Added the two-factor enrolment and the read-only state for admins without it.', 'Two-factor enrolment and admin read-only banner',
    'Two-factor: enrolment offers a passkey first, then an authenticator app with a QR code and a manual key, and ends with ten recovery codes to download. An admin without a second factor sees a yellow banner "Set up two-factor to manage this workspace" and every admin control is disabled until they enrol.',
  );
  x.rev('acct-ux', true, 'Approved. Disabling admin controls instead of hiding them tells people why.');
  x.tick('acct-ux', 'acct-api', 'acct-req', 'acct-tests');
  x.tick('acct-sec', 'acct-web', 'acct-sso');
  x.dv('acct-sec', 'First version of the account security review.', 'Threat model, second-factor rules and fix list',
    'Threat model (STRIDE): stolen sign-in links (single use, 15 minutes), session theft (refresh token rotation with reuse detection), invitation guessing (32-byte tokens, hashed), brute force (5 sign-in links per minute per IP and 20 per hour per email), SAML assertion replay (assertion ids kept for 10 minutes, 3 minutes of clock skew).',
    'Second factor: passkeys and authenticator apps only, no SMS (FAIL-SMS-OTP); owners and admins must enrol, members may. Fixes before release: cookie flags Secure, HttpOnly and SameSite=Lax on the web session; identity provider certificates in Secrets Manager.',
  );
  x.rev('acct-sec', true, 'Approved; clear and complete.');
  x.tick('acct-sec', 'acct-web', 'acct-tests');
  x.tick('acct-mobile', 'acct-tests', 'acct-sso');
  x.dv('acct-sso', 'First version of enterprise SAML sign-in.', 'SAML for Okta and Azure AD, domain verification, enforcement',
    'SAML 2.0 per workspace: an admin pastes the identity provider metadata URL, Quire verifies the email domain with a DNS TXT record, and members with that domain are sent to the provider. Signatures are checked on the assertion and the response, assertion ids are kept for 10 minutes against replay.',
    'Enforcement: the admin switch turns off email links and Google for every member of the workspace; one owner keeps an emergency email sign-in so a broken provider cannot lock the workspace out. Tested end to end against Okta and Azure AD test tenants.',
  );
  x.rev('acct-sso', true, 'Approved. The emergency owner sign-in answers the lock-out worry from the trials.');
  x.tick('acct-ux', 'acct-sec', 'acct-req', 'acct-mobile');
  x.status('Halfway through 3.1. A short status from each of you, please.', ['acct-req', 'acct-ux', 'acct-api', 'acct-sso', 'acct-web', 'acct-mobile', 'acct-sec', 'acct-tests']);
  x.qa({
    from: 'web', ws: 'acct-web', to: 'design', toWs: 'acct-ux',
    reply: 'Building the recovery codes screen.',
    q: 'should the recovery codes be shown once with a download button, or can the user see them again later in settings?',
    a: 'Once, with Download and Copy; settings only offers "Generate new codes", which invalidates the old ones. Showing them again would mean storing them in a readable form.',
  });
  x.tick('acct-web', 'acct-mobile', 'acct-api', 'acct-ux', 'acct-tests');
  x.dv('acct-mobile', 'First version of the mobile sign-in and account screens.', 'Sign-in, SAML, switcher, two-factor and account screens on iOS and Android',
    'Sign-in with email link, Google and SAML (in an ASWebAuthenticationSession on iOS and a Custom Tab on Android, with the one-time code exchanged at /v2/auth/sso/exchange). Tokens are kept in the Keychain and the Android Keystore; the refresh token rotates on every use.',
    'Account screens: the workspace switcher in a drawer, the account screen with "Sign out everywhere", account deletion (both stores require it in the app), and two-factor enrolment with passkeys or an authenticator app.',
  );
  x.rev('acct-mobile', false, 'On Android a failed refresh logs the user out silently and they lose the draft they were typing. Show the sign-in sheet over the current screen and keep the draft.', [
    'Nothing a person typed is ever thrown away by a client: when a session expires or the server refuses a change, the client keeps the text and tells the person what happened.',
  ]);
  x.tick('acct-mobile', 'acct-tests');
  x.dv('acct-mobile', 'Kept drafts across an expired session.', 'Sign-in sheet over the current screen; drafts kept',
    'Expired sessions: when the refresh token is rejected, a sign-in sheet opens over the current screen and the draft stays in memory and in SQLite; after signing in the user is back where they were. Verified with a refresh token revoked mid-edit on a Pixel 6 and an iPhone 12.',
  );
  x.rev('acct-mobile', true, 'Approved. Keeping the draft through a revoked session is exactly the behaviour we want everywhere.');
  x.tick('acct-web', 'acct-req', 'acct-sec', 'acct-mobile');
  x.dv('acct-web', 'Added two-factor enrolment and SAML redirect on the web.', 'Two-factor enrolment, SAML discovery, admin read-only state',
    'Two-factor and SAML: the sign-in page calls /v2/auth/sso/discover after the email is typed and redirects to the identity provider when the domain is verified. Enrolment offers passkeys (WebAuthn) and authenticator apps and shows the ten recovery codes once; admins without a second factor get the read-only banner and disabled controls.',
  );
  x.rev('acct-web', true, 'Approved. SAML discovery after the email field keeps the sign-in page simple.');
  x.tick('acct-ux', 'acct-mobile', 'acct-req', 'acct-tests');
  x.qa({
    from: 'qa', ws: 'acct-tests', to: 'ops', toWs: 'acct-sec',
    reply: 'Writing the second-factor cases.',
    q: 'how can a test reset an admin\'s second factor on staging without going through support?',
    a: 'Use the staging-only admin tool: quire-admin mfa reset --email <address>. It is not deployed to production and every use is logged.',
  });
  x.tick('acct-tests', 'acct-sso', 'acct-web', 'acct-mobile', 'acct-req');
  x.status('Last week of 3.1. One line each on what is left, please.', ['acct-req', 'acct-ux', 'acct-api', 'acct-sso', 'acct-web', 'acct-mobile', 'acct-sec', 'acct-tests']);
  x.dv('acct-tests', 'First version of the 3.1 test plan and the first run.', 'Plan traced to ACC-01..ACC-09, Playwright and Detox runs',
    'Plan: every story ACC-01 to ACC-09 traces to at least one case; 71 automated cases (Playwright for the web, Detox for iOS and Android) and 12 manual ones for SAML with Okta and Azure AD.',
    'First run on build 3.1.0-rc1: 68 of 71 automated cases pass. Failures: the invitation email arrives after 70 seconds under load, a switcher test is flaky, and one SAML case fails because the Azure AD tenant had an expired certificate.',
  );
  x.rev('acct-tests', false, 'The failures are listed but I cannot tell which story or build each one belongs to, so nobody knows whether rc2 fixed them. Name both in every result.', [
    'Every bug report and test result names the story id and the build number, for example ACC-03 / build 3.1.0-rc1 (CONV-STORY-AND-BUILD).',
  ]);
  b.fact('conv-story-and-build', 'CONV-STORY-AND-BUILD', ['qa', 'analyst', 'web', 'mobile'], {
    question: 'Which two identifiers must every bug report and test result name?',
    expect: ['story id', 'build number'],
  });
  x.tick('acct-tests', 'acct-api', 'acct-sec', 'acct-sso', 'acct-mobile', 'acct-web', 'acct-tests');
  x.dv('acct-tests', 'Release pass on rc2, with story and build on every result.', 'Release pass on 3.1.0-rc2; known issues',
    'Release pass on build 3.1.0-rc2: 71 of 71 automated and 12 of 12 manual cases pass. Fixed since rc1: ACC-03 / build 3.1.0-rc1 (invitation email delay, the mail queue now has its own workers), the flaky switcher case, and the Azure AD certificate. Known issue: ACC-08 / build 3.1.0-rc2, the Okta error page shows English only.',
  );
  x.rev('acct-tests', true, 'Approved for release; the Okta wording can follow in a patch.');
  x.close('acct-');
}
// ===========================================================================
// Cycle 2: billing (Quire 3.2)
// ===========================================================================

const BILL_WS = {
  req: { id: 'bill-req', title: 'Billing requirements and pricing', brief: 'Write the 3.2 billing requirements: the Free, Team and Business plans, what each includes, upgrades, downgrades, cancellations and invoices, as numbered stories BIL-nn with acceptance checklists.', owner: 'analyst', dependsOn: [] },
  ux: { id: 'bill-ux', title: 'Pricing page, checkout and billing settings UX', brief: 'Design the pricing page, the upgrade path from inside the editor, the billing settings for owners and the states of a failed payment, for the web; mobile shows the plan only.', owner: 'design', dependsOn: ['bill-req'] },
  service: { id: 'bill-service', title: 'Billing service on Stripe', brief: 'Build the billing service on Stripe Billing: customers per workspace, subscriptions, checkout, the customer portal, webhooks and the entitlements every client reads.', owner: 'backend', dependsOn: ['bill-req'] },
  web: { id: 'bill-web', title: 'Web pricing, checkout and billing settings', brief: 'Build the pricing page, the in-app upgrade prompts, Stripe Checkout redirects and the owner-only billing settings in the web app.', owner: 'web', dependsOn: ['bill-ux', 'bill-service'] },
  mobile: { id: 'bill-mobile', title: 'Mobile plan display and limits', brief: 'Show the workspace plan and its limits in the iOS and Android apps, with no purchase flow in the apps; owners manage billing on the web.', owner: 'mobile', dependsOn: ['bill-service'] },
  tax: { id: 'bill-tax', title: 'Tax, invoices and payment security', brief: 'Set up Stripe Tax for the countries we sell in, invoice numbering and storage, and keep card data out of our systems (PCI SAQ A).', owner: 'ops', dependsOn: ['bill-req'] },
  tests: { id: 'bill-tests', title: 'Billing test plan and release pass', brief: 'Write the 3.2 test plan, automate checkout, renewals and failed payments with Stripe test clocks, and run the release pass.', owner: 'qa', dependsOn: ['bill-web', 'bill-mobile', 'bill-service'] },
} satisfies Record<string, Ws>;

function cycleBilling(x: Ctx): void {
  const { b } = x;
  b.human(
    'Quire 3.1 is live and the three enterprise trials signed. Thank you all. Next is 3.2, billing: today Alex sends every paying team an invoice by hand from a spreadsheet. I want self-serve plans with Stripe, Free, Team and Business, so a team can upgrade from inside the editor in under a minute. @pm please set up the release the same way as 3.1.',
    ['pm'],
  );
  b.replan({
    workstreams: Object.values(BILL_WS),
    contracts: [
      { id: 'c-bill-req-tests', from: 'bill-req', to: 'bill-tests', spec: 'Stories are numbered BIL-nn with acceptance checklists that the test plan traces one to one, and every result names the story id and the build number.' },
      { id: 'c-bill-service-web', from: 'bill-service', to: 'bill-web', spec: 'Billing endpoints under /v2/billing: POST /checkout-sessions, POST /portal-sessions and GET /invoices. Errors use the {code, message, requestId} body with codes such as CARD_DECLINED and PLAN_LIMIT_REACHED, and every POST carries an Idempotency-Key.' },
      { id: 'c-bill-entitlements-web', from: 'bill-service', to: 'bill-web', spec: 'GET /v2/workspaces/{id}/entitlements returns {plan, seats, seatsUsed, features, renewsAt} (CONTRACT-ENTITLEMENTS); features is a list of flags such as saml, guests and version_history, and renewsAt is an ISO 8601 timestamp. Clients gate every paid feature on this response and never on a cached plan name.' },
      { id: 'c-bill-entitlements-mobile', from: 'bill-service', to: 'bill-mobile', spec: 'The same GET /v2/workspaces/{id}/entitlements response (CONTRACT-ENTITLEMENTS); the apps refresh it on launch and on the billing.changed push, and show limits from it.' },
      { id: 'c-bill-ux-web', from: 'bill-ux', to: 'bill-web', spec: 'Figma frames for the pricing page, upgrade prompts and billing settings, using UI kit names; the plan comparison table is generated from one JSON file that analyst owns.' },
      { id: 'c-bill-tax-service', from: 'bill-tax', to: 'bill-service', spec: 'Stripe Tax calculates VAT and sales tax on every invoice; invoice numbers are QUI-<year>-<5 digits> without gaps, and PDFs are kept for 10 years.' },
    ],
  });
  b.fact('contract-entitlements', 'CONTRACT-ENTITLEMENTS', ['web', 'mobile', 'backend', 'qa'], {
    question: 'Which fields does the entitlements response return?',
    expect: ['seatsUsed', 'renewsAt'],
  });

  x.tasks('bill-req', [
    'the pricing interviews with nine teams that pay by invoice today, which put the pain at chasing the yearly invoice rather than the price itself',
    'the plan table: Free up to 3 members and 100 documents, Team with unlimited documents and guests, Business with SAML sign-in and version history',
    'the upgrade story from inside the editor, where the prompt appears at the 100th document or the 4th member',
    'the downgrade story, including what happens to guests and SAML when a workspace moves from Business to Team',
    'the cancellation story: the plan runs to the end of the period, then the workspace becomes Free and keeps every document',
    'the invoice stories for teams whose finance departments need a purchase order number on every invoice',
    'the migration plan for the 214 teams on hand-made invoices, who keep their current price for twelve months',
    'acceptance checklists for BIL-01 to BIL-08 with the money amounts written out',
    'the rules for owners only: only an owner can see invoices, change the plan or the card',
    'the edge case of a workspace with more members than the plan it downgrades to',
    'the price display rules for euros, pounds and dollars and where each currency applies',
    'a read-through of every story with Alex from finance, who found two invoice cases we had missed',
    'the release notes draft for 3.2',
    'the help centre outline for plans and invoices',
    'a last check of the plan JSON file against the stories',
  ]);
  x.tasks('bill-ux', [
    'a teardown of six competitors\' pricing pages, noting that four hide the per-seat price behind a toggle',
    'the plan comparison table built from the plan JSON file, with the most common plan highlighted',
    'the upgrade prompt that appears inside the editor at the free limit, with the cheapest plan that removes the limit',
    'the owner billing settings page with plan, seats, card and invoices in one column',
    'the redirect states into and back from Stripe Checkout, including the cancelled checkout',
    'the failed-payment banner and its three levels of urgency',
    'the downgrade dialog that lists exactly which features stop working',
    'the empty invoice list for workspaces that have never paid',
    'the mobile plan card that shows limits without any buy button',
    'a usability test of the upgrade path with five people, timed from prompt to paid',
    'the purchase order number field on the billing settings page',
    'contrast checks for the price table, which uses brand purple on white',
    'the annual billing toggle and how the saving is shown',
    'the redlines for the web engineers',
    'the hand-off notes for QA listing every billing state from trial to canceled',
  ]);
  x.tasks('bill-service', [
    'the Stripe account set-up with test and live mode keys kept apart per environment',
    'the customers table linking each workspace to one Stripe customer, created lazily on first checkout',
    'POST /v2/billing/checkout-sessions that creates a Stripe Checkout session for a plan and seat count',
    'the webhook endpoint for checkout.session.completed and customer.subscription.updated',
    'the entitlements table that the webhook handler writes and every request reads',
    'GET /v2/workspaces/{id}/entitlements with a five-second in-process cache per workspace',
    'the customer portal session endpoint for cards and invoices',
    'the plan limit checks in the document and membership handlers',
    'the migration job that creates Stripe subscriptions for the 214 invoiced teams at their current price',
    'renewal handling for invoice.paid and invoice.payment_failed',
    'Stripe test clock fixtures for renewals and failed payments',
    'the purchase order number stored on the customer and printed on invoices',
    'load tests of the entitlements endpoint at 2,000 requests per second',
    'the runbook for webhook backlogs and replays',
    'the final API document for billing',
  ]);
  x.tasks('bill-web', [
    'regenerating the API client with the billing endpoints and their error codes',
    'the pricing page rendered from the plan JSON file, server-side for search engines',
    'the upgrade prompt at the free limits, triggered by PLAN_LIMIT_REACHED from the API',
    'the redirect to Stripe Checkout and the return route that waits for the webhook',
    'the billing settings page for owners with plan, seats and invoices',
    'the portal button for changing the card',
    'the failed-payment banner wired to the entitlements response',
    'the downgrade dialog with the list of features that stop',
    'the annual toggle on the pricing page',
    'the purchase order number field',
    'Playwright cases for checkout with the Stripe test cards',
    'the bundle check after adding the pricing page',
    'the copy review with analyst for every billing string',
    'a last pass on keyboard and screen reader behaviour on the pricing table',
    'a last visual pass on the pricing page against the redlines at 320, 768 and 1440 px',
  ]);
  x.tasks('bill-mobile', [
    'the plan card on the workspace screen with plan name and renewal date',
    'reading the entitlements response on launch and caching it for offline display',
    'the billing.changed silent push that refreshes the plan within a minute of a change',
    'the limit messages at the free limits, which tell the member to ask an owner',
    'a review of the App Store and Play rules for apps whose plans are bought on the web',
    'removing every price and buy link from the apps',
    'the owner view, which says "Manage billing on quire.app" without a link',
    'the guest limit message when a workspace is on Free',
    'Detox cases for the plan card and limit messages',
    'a pass on dynamic type and large fonts for the plan card',
    'release builds 3.2.0 for TestFlight and the Play internal track, with the plan card in the store screenshots',
    'the store review notes explaining that the apps sell nothing',
    'checking the plan card in German and French',
    'the final review of limit messages with design',
  ]);
  x.tasks('bill-tax', [
    'the list of countries where we already collect VAT or sales tax, from last year\'s hand-made invoices',
    'Stripe Tax registration for the EU one-stop shop, the UK and four US states',
    'the tax codes for the Team and Business products',
    'invoice numbering as QUI-<year>-<5 digits> without gaps across live mode',
    'the 10-year archive of invoice PDFs in an object-locked bucket',
    'the PCI scope review, confirming that card data only ever touches Stripe Checkout',
    'the webhook secret and API keys in Secrets Manager with rotation every 90 days',
    'alerts on webhook failures above 1% over ten minutes',
    'the finance export of paid invoices for the accountants every month',
    'the refund policy and who may issue refunds in the Stripe dashboard',
    'Stripe dashboard access limited to two people with hardware keys',
    'the tax report for the first quarter of self-serve sales',
    'the payment security sign-off for 3.2',
    'the hand-over notes for finance',
  ]);
  x.tasks('bill-tests', [
    'tracing BIL-01 to BIL-08 to test cases',
    'the staging seed with one workspace per plan and one past its free limits',
    'Stripe test clock scenarios for monthly and annual renewals',
    'checkout cases with the Stripe test cards for success, decline and 3-D Secure',
    'webhook replay cases that send every event twice',
    'downgrade cases from Business to Team with SAML switched on',
    'the free limit cases at 100 documents and 4 members',
    'failed payment cases through every dunning stage',
    'invoice cases with and without a purchase order number',
    'mobile cases for the plan card and limit messages',
    'tax cases for Germany, the UK and California',
    'the regression run on the editor and accounts flows',
    'the release pass on build 3.2.0-rc2',
    'the known-issues list for 3.2, agreed with finance',
    'the 3.2 sign-off notes, with finance\'s check of the first live invoices',
  ]);

  x.start('bill-req', 'Starting the 3.2 billing requirements from the pricing interviews.', 'bill-req: plans Free/Team/Business; stories BIL-nn; owners only for money.');
  x.start('bill-service', 'Starting the billing service. Stripe account and keys first, then customers and checkout.', 'bill-service: Stripe Billing + Checkout; customers per workspace; entitlements table read by every request.', 'c-bill-entitlements-web');
  x.start('bill-tax', 'Starting tax and invoices with the list of countries we already invoice.', 'bill-tax: Stripe Tax; numbering QUI-<year>-nnnnn; 10-year PDF archive; PCI SAQ A.', 'c-bill-tax-service');
  x.tick('bill-req', 'bill-service', 'bill-tax');
  x.qa({
    from: 'analyst', ws: 'bill-req', to: 'ops', toWs: 'bill-tax',
    reply: 'Writing the price display rules.',
    q: 'which countries do we have to charge VAT or sales tax in from the first self-serve invoice, so I know which prices show "excl. VAT"?',
    a: 'From day one: every EU country through the one-stop shop, the UK, and New York, Texas, Washington and Pennsylvania in the US. Prices in the EU and UK show "excl. VAT" for businesses; the US shows tax at checkout.',
  });
  x.tick('bill-req', 'bill-service');
  x.start('bill-ux', 'Starting the pricing and billing flows with a look at how others show per-seat prices.', 'bill-ux: competitor teardown; table from plan JSON; upgrade prompt at the free limit; owner billing page.', 'bill-req');
  x.tick('bill-ux', 'bill-req', 'bill-tax');
  x.dv('bill-req', 'First version of the 3.2 billing requirements.', 'Plans, limits and stories BIL-01 to BIL-06',
    'Plans: Free (up to 3 members and 100 documents), Team (EUR 49 a month per workspace for up to 10 members, unlimited documents, guests) and Business (EUR 99 a month for up to 25 members, adds SAML sign-in and 90 days of version history). Only owners see prices, invoices and the card.',
    'Stories: BIL-01 upgrade from the editor; BIL-02 pay with a card through Stripe Checkout; BIL-03 see and download invoices; BIL-04 downgrade; BIL-05 cancel; BIL-06 add a purchase order number. The 214 teams on hand-made invoices move to Stripe at their current price for twelve months.',
  );
  x.rev('bill-req', false, 'Good start, but there are no acceptance checklists again, and "only owners" does not say who enforces it. The 3.1 rule applies: the server checks the role on every billing request, the UI only mirrors it. Add both before anyone builds against this.');
  x.tick('bill-req', 'bill-ux');
  x.dv('bill-req', 'Added checklists and the owner rule for billing.', 'Acceptance checklists for BIL-01 to BIL-06; owner-only billing on the server',
    'Acceptance checklists: BIL-01 a member who creates the 101st document on Free sees the upgrade prompt, and an owner who completes checkout can create it within 10 seconds of paying. BIL-04 a downgrade from Business lists the features that stop (SAML sign-in, version history beyond 7 days) and takes effect at the end of the period. Every billing endpoint is restricted to owners by the server-side role check from 3.1; members get 403 FORBIDDEN_ROLE.',
  );
  x.rev('bill-req', true, 'Approved as the 3.2 baseline.');
  x.start('bill-web', 'Starting the web side of billing: client first, then the pricing page.', 'bill-web: regenerate client; /pricing server-rendered; upgrade prompt on PLAN_LIMIT_REACHED; owner-only settings.', 'c-bill-service-web');
  x.start('bill-mobile', 'Starting the plan display in the apps; no purchase flow on mobile.', 'bill-mobile: plan card from entitlements; billing.changed push; no prices or buy links.', 'c-bill-entitlements-mobile');
  x.start('bill-tests', 'Starting the 3.2 test plan with Stripe test clocks in mind.', 'bill-tests: trace BIL-nn; one workspace per plan; test clocks for renewals; webhook replays.', 'c-bill-req-tests');
  x.tick('bill-service', 'bill-tax', 'bill-web', 'bill-mobile');
  x.qa({
    from: 'web', ws: 'bill-web', to: 'backend', toWs: 'bill-service',
    reply: 'Planning the checkout return route.',
    q: 'after Stripe Checkout redirects back, the webhook may not have arrived yet. Should the return page poll the entitlements endpoint, or is there a status endpoint for the checkout session?',
    a: 'Poll GET /v2/billing/checkout-sessions/{id} every second for up to 20 seconds; it returns pending, paid or expired and reads Stripe directly if our webhook has not arrived yet. When it says paid, refetch the entitlements.',
  });
  x.record({ id: 'c-bill-checkout-web', from: 'bill-service', to: 'bill-web', spec: 'After the Stripe Checkout redirect the web app polls GET /v2/billing/checkout-sessions/{id} every second for up to 20 seconds; it returns pending, paid or expired and reads Stripe when the webhook has not arrived; on paid the client refetches the entitlements.' });
  x.tick('bill-service', 'bill-ux', 'bill-tests');
  x.dv('bill-service', 'First version of the billing service.', 'Customers, checkout, webhooks and entitlements on Stripe',
    'Stripe Billing with one Stripe customer per workspace, created on first checkout. POST /v2/billing/checkout-sessions creates a Checkout session for a plan; the webhook handler applies checkout.session.completed and customer.subscription.updated to the entitlements table, which every request reads.',
    'Amounts: plan prices are kept as decimal euros in a float column (49.0, 99.0) and returned as numbers; the currency is implied by the workspace country. GET /v2/workspaces/{id}/entitlements returns the plan, seats, features and renewsAt.',
  );
  x.rev('bill-service', false, 'Floats for money will round: 3 seats at 8.10 is 24.299999 in the logs already, and an implied currency breaks the moment a UK team pays in pounds. Fix the money model everywhere it appears, including what clients receive.', [
    'Money is an integer amount in minor units plus an ISO 4217 currency code, for example {amount: 4900, currency: "EUR"}, in the database, the API, events and exports; never a float (CONV-MONEY-MINOR-UNITS).',
  ]);
  b.fact('conv-money-minor-units', 'CONV-MONEY-MINOR-UNITS', ['backend', 'web', 'mobile', 'analyst'], {
    question: 'How must money amounts be represented in the database, the API, events and exports?',
    expect: ['minor units', 'ISO 4217'],
  });
  x.tick('bill-web', 'bill-mobile', 'bill-tax');
  x.qa({
    from: 'mobile', ws: 'bill-mobile', to: 'analyst', toWs: 'bill-req',
    reply: 'Checking what the apps may show about plans.',
    q: 'may the apps show prices or a link to the pricing page, or only the plan the workspace already has?',
    a: 'Only the plan the workspace has and its limits. No prices, no buy button and no link to the pricing page; an owner reads "Manage billing on quire.app". That keeps both app stores out of it, and members cannot buy anyway.',
  });
  x.record({ id: 'c-bill-mobile-display', from: 'bill-req', to: 'bill-mobile', spec: 'The apps show only the workspace plan and its limits: no prices, no buy button and no link to the pricing page; owners read "Manage billing on quire.app".' });
  x.tick('bill-ux', 'bill-req', 'bill-service');
  x.dv('bill-ux', 'First version of the pricing page and billing settings.', 'Pricing table, upgrade prompt, billing settings and payment states',
    'Pricing page: three columns from the plan JSON file with Team highlighted, the price per workspace per month and an annual toggle. The upgrade prompt appears in the editor at the free limit with the cheapest plan that removes it and one button to checkout.',
    'Billing settings (owners only): plan and renewal date, members used out of the plan limit, the card through the Stripe portal, invoices with PDF links and a purchase order number field. A failed payment shows a banner at three levels: a notice, a warning after 7 days and a red bar after 14 days.',
  );
  x.rev('bill-ux', false, 'The purple prices on white are 3.6:1 and the toggle has no visible focus state; that fails the 3.1 accessibility rule on the one page every customer sees. Fix contrast and focus across the billing screens.');
  x.tick('bill-ux', 'bill-web');
  x.dv('bill-ux', 'Fixed contrast and focus on the billing screens.', 'Accessible pricing table and toggle',
    'Accessibility: prices now use purple-800 (8.1:1), the annual toggle is a real switch with a 2 px focus ring and an "Annual, 2 months free" label read by screen readers, and the table has row headers. Checked every billing screen against WCAG 2.2 AA with axe and VoiceOver.',
  );
  x.rev('bill-ux', true, 'Approved. The annual label is read correctly by VoiceOver now.');
  x.tick('bill-service', 'bill-tests', 'bill-req');
  b.work('backend', 'bill-service', 'Recording a failed approach (FAIL-NIGHTLY-PRORATION): I tried a nightly proration job that compared seat counts with yesterday\'s and charged the difference. A seat added and removed on the same day was charged and never credited, and two staging workspaces were billed twice when the job retried. Seat changes now go to Stripe immediately as subscription quantity updates with prorations.', [
    op.failure(
      'A nightly proration job that compares seat counts with the previous day and charges the difference (FAIL-NIGHTLY-PRORATION).',
      'Seats added and removed within a day were charged but never credited, and a retried run billed two staging workspaces twice; Stripe prorates correctly when the quantity is updated at the moment of the change.',
      ['bill-service'],
    ),
  ]);
  b.fact('fail-nightly-proration', 'FAIL-NIGHTLY-PRORATION', ['backend', 'qa', 'analyst'], {
    question: 'Which approach to charging seat changes was tried and failed?',
    expect: ['nightly proration', 'nightly'],
  });
  x.tick('bill-tax', 'bill-mobile', 'bill-web');

  // Change 1: per-seat pricing
  b.human(
    'Change of plan on pricing (CHANGE-PER-SEAT-PRICING): the flat workspace prices do not work. Small teams of 4 think EUR 49 is steep and the 30-person agency hits the Business cap. We switch to per-seat pricing: Team EUR 8 per seat per month, Business EUR 14 per seat per month, annual billing pays for 10 months. Free stays as it is. Please replan around per seat instead of per workspace.',
  );
  b.fact('change-per-seat-pricing', 'CHANGE-PER-SEAT-PRICING', ['*'], {
    question: 'How is the Team plan priced? Give only the current value.',
    expect: ['EUR 8 per seat', 'per-seat'],
  });
  b.replan({
    workstreams: b.currentPlan.workstreams.map(w =>
      w.id === 'bill-req'
        ? { ...w, brief: 'Write the 3.2 billing requirements for per-seat pricing (Team EUR 8, Business EUR 14 per seat per month, annual pays for 10 months): seat counting, upgrades, downgrades, cancellations and invoices, as stories BIL-nn with acceptance checklists.' }
        : w.id === 'bill-service'
          ? { ...w, brief: 'Build the billing service on Stripe Billing with per-seat subscriptions: seat counts follow memberships immediately with prorations, checkout, the customer portal, webhooks and the entitlements every client reads.' }
          : w.id === 'bill-ux'
            ? { ...w, brief: 'Design the per-seat pricing page, the seat changes an owner sees when inviting people, the billing settings for owners and the states of a failed payment, for the web; mobile shows the plan only.' }
            : w,
    ),
    contracts: [
      ...b.currentPlan.contracts.filter(c => c.id !== 'c-bill-entitlements-web'),
      { id: 'c-bill-entitlements-web', from: 'bill-service', to: 'bill-web', spec: 'GET /v2/workspaces/{id}/entitlements returns {plan, seats, seatsUsed, pricePerSeat, features, renewsAt}; pricePerSeat is {amount, currency} in minor units and renewsAt an ISO 8601 timestamp. Inviting a member beyond the paid seats returns 402 SEATS_REQUIRED with the price of one more seat.' },
    ],
  });
  x.dv('bill-req', 'Rewrote the plans and stories for per-seat pricing.', 'Per-seat plans; seat counting rules; BIL-07 and BIL-08',
    'Per-seat pricing: Team costs EUR 8 and Business EUR 14 per seat per month; annual billing pays for 10 months. A seat is a member or admin; guests and owners of personal workspaces do not count. BIL-07 an owner who invites a member beyond the paid seats sees the new monthly total before the invitation is sent; BIL-08 removing a member credits the unused part of the seat on the next invoice.',
  );
  x.rev('bill-req', true, 'Approved; this is what the owner asked for.');
  x.tick('bill-ux', 'bill-service', 'bill-tests', 'bill-web', 'bill-mobile');
  x.qa({
    from: 'web', ws: 'bill-web', to: 'backend', toWs: 'bill-service',
    reply: 'Building the failed-payment banner.',
    q: 'what states does a workspace go through when a card keeps failing, and how long is each one, so the banner and the editor behave the same as the API?',
    a: 'Four states, exposed as billingState in the entitlements response (CONTRACT-DUNNING-STATES): active; past_due for 14 days after the first failed charge while Stripe retries, with everything working; read_only from day 15, where documents open but nobody can edit or invite; canceled after 60 days, which moves the workspace to Free. @mobile @design please use the same names and days.',
    also: ['mobile', 'design'],
  });
  b.fact('contract-dunning-states', 'CONTRACT-DUNNING-STATES', ['web', 'mobile', 'design', 'qa', 'backend'], {
    question: 'Which billing states does the entitlements response expose?',
    expect: ['past_due', 'read_only'],
  });
  x.tick('bill-web', 'bill-mobile', 'bill-req');
  x.dv('bill-service', 'Reworked the money model and moved to per-seat subscriptions.', 'Minor units with currency; per-seat quantities with immediate prorations',
    'Revision after review: every amount is an integer in minor units with an ISO 4217 currency, in Postgres, in the API and in events. Subscriptions are per seat: adding or removing a member updates the Stripe subscription quantity at once with prorations, so the nightly job is gone. Inviting beyond the paid seats returns 402 SEATS_REQUIRED.',
  );
  x.rev('bill-service', false, 'The money model is right now. But the webhook handler trusts any POST to /webhooks/stripe and applies the same event twice when Stripe retries; I replayed one event and the workspace got two seat credits. Fix both.', [
    'Every incoming webhook is checked against its provider signature (Stripe-Signature with the endpoint secret) and is processed at most once by its event id; unsigned or repeated events return 200 without effect (CONV-WEBHOOKS-VERIFIED).',
  ]);
  b.fact('conv-webhooks-verified', 'CONV-WEBHOOKS-VERIFIED', ['backend', 'ops', 'qa'], {
    question: 'How must incoming webhooks be checked and de-duplicated?',
    expect: ['signature', 'event id'],
  });
  x.tick('bill-service', 'bill-tax', 'bill-ux', 'bill-mobile');
  x.status('Two weeks into 3.2. Short status from each of you, please, and flag anything at risk.', ['bill-req', 'bill-ux', 'bill-service', 'bill-web', 'bill-mobile', 'bill-tax', 'bill-tests']);
  x.tick('bill-service', 'bill-web', 'bill-tests');
  x.dv('bill-service', 'Verified webhooks and made them safe to repeat.', 'Signature checks and once-only processing of webhooks',
    'Webhooks: every request to /webhooks/stripe is checked against the Stripe-Signature header with the endpoint secret and a 5-minute tolerance; processed event ids are stored, so a repeated event returns 200 and changes nothing. The four billing states (active, past_due, read_only, canceled) are written from invoice.payment_failed and invoice.paid and returned as billingState.',
  );
  x.rev('bill-service', true, 'Approved. Web and mobile can rely on this version.');
  x.tick('bill-web', 'bill-ux');
  x.qa({
    from: 'ops', ws: 'bill-tax', to: 'backend', toWs: 'bill-service',
    reply: 'Writing the PCI scope note.',
    q: 'does any card number, even the last four digits, pass through our API or logs, or does it all stay inside Stripe Checkout and the portal?',
    a: 'Nothing passes through us: Checkout and the portal are Stripe-hosted pages, and we store only the card brand and the last four digits that Stripe sends in the webhook, which PCI allows. Request logs drop the webhook body entirely.',
  });
  x.tick('bill-tax', 'bill-mobile', 'bill-req', 'bill-tests');
  x.dv('bill-web', 'First version of the web pricing, checkout and billing settings.', 'Pricing page, upgrade prompts, checkout and owner billing settings',
    'Pricing page server-rendered from the plan JSON file with the per-seat prices and the annual toggle; upgrade prompts open on PLAN_LIMIT_REACHED and SEATS_REQUIRED from the API with the new monthly total. Checkout redirects to Stripe and the return route polls the checkout session for up to 20 seconds.',
    'Billing settings for owners: plan, seats used, renewal date, the Stripe portal for the card, invoices with PDF links and the purchase order number field. The failed-payment banner follows billingState from the entitlements response: past_due shows a notice, read_only a red bar and a disabled editor.',
  );
  x.rev('bill-web', true, 'Approved; the checkout return flow is smooth.');
  x.tick('bill-mobile', 'bill-tests', 'bill-ux', 'bill-service');
  x.dv('bill-tax', 'First version of tax, invoices and payment security.', 'Stripe Tax, invoice numbering and archive, PCI SAQ A',
    'Tax: Stripe Tax registered for the EU one-stop shop, the UK and New York, Texas, Washington and Pennsylvania; Team and Business use the SaaS tax code. Invoices are numbered QUI-<year>-<5 digits> without gaps and their PDFs are kept for 10 years in an object-locked bucket.',
    'Payment security: card data only touches Stripe-hosted pages (PCI SAQ A); our database stores the brand and last four digits. Stripe keys and the webhook secret live in Secrets Manager and rotate every 90 days; dashboard access is limited to two people with hardware keys.',
  );
  x.rev('bill-tax', true, 'Approved. Two people with hardware keys on the Stripe dashboard is the right size.');
  x.tick('bill-tax', 'bill-req', 'bill-web', 'bill-ux');

  // Change 2: reverse charge for EU business customers
  b.human(
    'Change of requirements from finance (CHANGE-VAT-REVERSE-CHARGE): EU business customers with a valid VAT ID must get reverse-charge invoices without VAT, and the VAT ID has to be checked against VIES at checkout and again every month. Right now Stripe Tax charges them German VAT, which their accountants reject. This is now part of 3.2.',
  );
  b.fact('change-vat-reverse-charge', 'CHANGE-VAT-REVERSE-CHARGE', ['backend', 'ops', 'analyst', 'web', 'qa'], {
    question: 'How must invoices be issued to EU business customers with a valid VAT ID? Give only the current value.',
    expect: ['reverse-charge', 'VIES'],
  });
  b.replan({
    workstreams: b.currentPlan.workstreams.map(w =>
      w.id === 'bill-tax'
        ? { ...w, brief: 'Set up Stripe Tax for the countries we sell in, reverse-charge invoices for EU businesses with a VAT ID validated against VIES at checkout and monthly, invoice numbering and storage, and keep card data out of our systems (PCI SAQ A).' }
        : w.id === 'bill-web'
          ? { ...w, brief: 'Build the per-seat pricing page, the in-app upgrade prompts, Stripe Checkout redirects with VAT ID collection for EU businesses, and the owner-only billing settings in the web app.' }
          : w,
    ),
    contracts: [
      ...b.currentPlan.contracts,
      { id: 'c-bill-dunning-web', from: 'bill-service', to: 'bill-web', spec: 'billingState in the entitlements response is active, past_due (14 days of retries, everything works), read_only (from day 15: documents open, nobody edits or invites) or canceled (after 60 days, the workspace becomes Free); the editor and the banner follow it.' },
      { id: 'c-bill-dunning-mobile', from: 'bill-service', to: 'bill-mobile', spec: 'The same billingState values and days; the apps show the read_only state on every document and disable editing.' },
      { id: 'c-bill-vat-web', from: 'bill-tax', to: 'bill-web', spec: 'Checkout collects an optional VAT ID for EU businesses; the service validates it against VIES and returns VAT_ID_INVALID in the error body when VIES says no, so the page can show the reason.' },
    ],
  });
  x.tick('bill-tax', 'bill-web', 'bill-tests');
  x.qa({
    from: 'ops', ws: 'bill-tax', to: 'analyst', toWs: 'bill-req',
    reply: 'Configuring reverse charge in Stripe Tax.',
    q: 'what exact sentence must a reverse-charge invoice carry, and in which languages?',
    a: 'English plus the customer\'s language where we have it: "Reverse charge: VAT to be accounted for by the recipient (Article 196, Council Directive 2006/112/EC)", the customer\'s VAT ID and ours. Finance confirmed German, French and Dutch versions.',
  });
  x.dv('bill-tax', 'Added reverse charge and VIES checks.', 'Reverse-charge invoices for EU businesses; VIES validation',
    'Reverse charge: an EU business with a VAT ID that VIES confirms gets invoices without VAT and with the Article 196 sentence in English plus German, French or Dutch. VAT IDs are checked against VIES at checkout and on the first of every month; when VIES rejects a stored ID the next invoice includes VAT and the owner gets an email.',
  );
  x.rev('bill-tax', false, 'VIES is down for hours several times a month. As written, an outage at checkout blocks the purchase and the monthly job would add VAT to every customer it could not reach. Say what happens when VIES does not answer.', [
    'Every call to an outside service that can be unavailable (VIES, Stripe, identity providers) has a timeout, a retry plan and a written behaviour for when it does not answer.',
  ]);
  x.tick('bill-tax', 'bill-mobile', 'bill-service', 'bill-tests');
  x.dv('bill-tax', 'Handled VIES outages.', 'VIES outages: accept at checkout, recheck later',
    'VIES outages: at checkout an unreachable VIES accepts the VAT ID provisionally and the service retries every hour for 72 hours; the monthly job keeps the previous result when VIES does not answer and only acts on an explicit rejection. Every check and its answer is kept with the invoice for the tax auditors.',
  );
  x.rev('bill-tax', true, 'Approved. Keeping every VIES answer with the invoice will matter in a tax audit.');
  x.tick('bill-web', 'bill-tests', 'bill-req', 'bill-service', 'bill-tax');
  x.status('Week four of 3.2. Status from each of you, please, including anything finance still needs from you.', ['bill-req', 'bill-ux', 'bill-service', 'bill-web', 'bill-mobile', 'bill-tax', 'bill-tests']);
  x.dv('bill-web', 'Added VAT ID collection and the dunning states to the web app.', 'VAT ID at checkout; read_only editor; past_due banner',
    'VAT IDs: EU business customers can enter a VAT ID before checkout; VAT_ID_INVALID from the API is shown next to the field with the VIES reason. Dunning: past_due shows a notice with the retry date, read_only disables editing and inviting and shows a red bar with "Update card" for owners, and canceled returns the workspace to the Free limits.',
  );
  x.rev('bill-web', true, 'Approved. The VIES reason next to the field saves a support ticket per mistake.');
  b.work('backend', 'bill-service', 'Recording a failed approach (FAIL-CACHED-SEAT-COUNT): the seat count cache in Redis drifted from the memberships table whenever an invitation was accepted on one API instance and a member removed on another, and three staging workspaces showed 2 seats used out of 5 with 6 members. The entitlements endpoint now counts seats from Postgres and caches the whole response for 5 seconds only.', [
    op.failure(
      'Keeping a cached seat count per workspace in Redis, updated on every membership change (FAIL-CACHED-SEAT-COUNT).',
      'Concurrent membership changes on different API instances made the cached seat count drift from the memberships table, so workspaces were billed for the wrong number of seats.',
      ['bill-service'],
    ),
  ]);
  b.fact('fail-cached-seat-count', 'FAIL-CACHED-SEAT-COUNT', ['backend', 'qa'], {
    question: 'What was the failed way of tracking how many seats are used?',
    expect: ['cached seat count', 'Redis'],
  });
  x.tick('bill-service', 'bill-ux', 'bill-mobile', 'bill-web');
  x.dv('bill-mobile', 'First version of the plan display in the apps.', 'Plan card, limit messages and billing states on iOS and Android',
    'Plan card on the workspace screen with the plan, seats used and renewal date from the entitlements response, refreshed on launch and on the billing.changed silent push. No prices, buy buttons or links anywhere in the apps; owners read "Manage billing on quire.app".',
    'Billing states: past_due shows a notice on the workspace screen; read_only shows a lock on every document and disables the editor and invitations, as on the web; members who hit a free limit are told to ask an owner.',
  );
  x.rev('bill-mobile', false, 'The plan card shows "renews 3/4/2027", which American and European users read as different days, and the seats line is cut off at large font sizes. Use the device locale for dates from the UTC value and let the card grow.', [
    'Dates and times shown to people are converted from UTC to the viewer\'s locale and time zone with the month written out; numeric day/month formats are not used.',
  ]);
  x.tick('bill-mobile', 'bill-tests', 'bill-req');
  x.dv('bill-mobile', 'Fixed dates and large fonts on the plan card.', 'Locale dates from UTC; card grows with dynamic type',
    'Dates: renewsAt is parsed as ISO 8601 UTC and shown in the device locale with the month written out ("4 March 2027", "March 4, 2027"). The plan card grows with dynamic type up to the largest accessibility size; checked on an iPhone SE and a 360 dp Android phone.',
  );
  x.rev('bill-mobile', true, 'Approved. Written-out months remove the 3/4 ambiguity.');
  x.qa({
    from: 'qa', ws: 'bill-tests', to: 'backend', toWs: 'bill-service',
    reply: 'Automating renewals and the dunning stages.',
    q: 'can staging attach a Stripe test clock to a seeded workspace, so a test can move it 15 days ahead and check read_only?',
    a: 'Yes: POST /internal/billing/test-clocks with the workspace id creates the clock and moves the subscription onto it, and POST /internal/billing/test-clocks/{id}/advance takes days. Both exist only in test mode.',
  });
  x.tick('bill-tests', 'bill-ux', 'bill-req', 'bill-tax', 'bill-web');
  x.status('Last week of 3.2. One line each on what is left, please.', ['bill-req', 'bill-ux', 'bill-service', 'bill-web', 'bill-mobile', 'bill-tax', 'bill-tests']);
  x.tick('bill-tests', 'bill-req', 'bill-mobile', 'bill-ux', 'bill-service', 'bill-web');
  x.dv('bill-tests', 'First version of the 3.2 test plan and the first run.', 'Plan traced to BIL-01..BIL-08; test clocks; webhook replays',
    'Plan: BIL-01 to BIL-08 trace to 58 automated cases and 9 manual ones; test clocks cover monthly and annual renewals and every dunning stage up to canceled; every webhook test sends its event twice.',
    'First run, BIL-02 / build 3.2.0-rc1: 55 of 58 pass. Failures: BIL-07 / build 3.2.0-rc1, the new monthly total ignores annual plans; BIL-05 / build 3.2.0-rc1, cancelling during past_due keeps the red bar; a flaky checkout redirect wait.',
  );
  x.rev('bill-tests', false, 'The run is clear, but there are no tax cases at all and the downgrade from Business with SAML switched on is not tested. Both are in the stories.');
  x.tick('bill-tests', 'bill-req', 'bill-tests', 'bill-ux', 'bill-mobile', 'bill-tax');
  x.dv('bill-tests', 'Added tax and downgrade cases; release pass on rc2.', 'Tax and SAML downgrade cases; release pass on 3.2.0-rc2',
    'New cases: VAT for a German consumer, reverse charge for a Dutch business with a valid VAT ID, UK VAT, California with no tax, a VIES outage at checkout, and a Business-to-Team downgrade with SAML enforced, which turns SAML off at the end of the period and emails the owners first.',
    'Release pass on build 3.2.0-rc2: 66 of 66 automated and 9 of 9 manual cases pass, including BIL-07 / build 3.2.0-rc1 and BIL-05 / build 3.2.0-rc1, now fixed. Known issue: BIL-03 / build 3.2.0-rc2, invoice PDFs list the purchase order number only from the next invoice on.',
  );
  x.rev('bill-tests', true, 'Approved for release; finance accepts the purchase order issue for one invoice cycle.');
  x.close('bill-');
}

// ===========================================================================
// Cycle 3: collaboration (Quire 3.3)
// ===========================================================================

const COLLAB_WS = {
  req: { id: 'collab-req', title: 'Collaboration requirements', brief: 'Write the 3.3 requirements for real-time co-editing, presence, comments and @mentions, and sharing a single document with people outside the workspace, as stories COL-nn with acceptance checklists.', owner: 'analyst', dependsOn: [] },
  ux: { id: 'collab-ux', title: 'Co-editing, presence and comments UX', brief: 'Design presence avatars and cursors, comment threads in the margin, @mention pickers, notifications and the share dialog for a single document, on web and mobile.', owner: 'design', dependsOn: ['collab-req'] },
  sync: { id: 'collab-sync', title: 'Real-time sync server', brief: 'Build the service that merges concurrent edits to a document, keeps snapshots, broadcasts presence and stores comments, behind a websocket endpoint per document.', owner: 'backend', dependsOn: ['collab-req'] },
  web: { id: 'collab-web', title: 'Web editor co-editing and comments', brief: 'Connect the web editor to the sync server: live edits, presence cursors, comment threads, @mentions and the share dialog.', owner: 'web', dependsOn: ['collab-ux', 'collab-sync'] },
  mobile: { id: 'collab-mobile', title: 'Mobile co-editing and comments', brief: 'Connect the mobile editor to the sync server: live edits, presence, comment threads and @mention notifications on iOS and Android.', owner: 'mobile', dependsOn: ['collab-ux', 'collab-sync'] },
  infra: { id: 'collab-infra', title: 'Realtime gateway and capacity', brief: 'Run the websocket gateway in front of the sync servers, route each document to one server, size the fleet for 20,000 concurrent editors and alert on sync lag.', owner: 'ops', dependsOn: ['collab-sync'] },
  tests: { id: 'collab-tests', title: 'Collaboration test plan and release pass', brief: 'Write the 3.3 test plan, automate multi-client editing with simulated bad networks, load-test the gateway and run the release pass.', owner: 'qa', dependsOn: ['collab-web', 'collab-mobile', 'collab-infra'] },
} satisfies Record<string, Ws>;

const COLLAB_DOCS: Ws = { id: 'collab-docs', title: 'Collaboration help centre and in-app tour', brief: 'Write the help centre articles for co-editing, comments, mentions, suggestions and sharing, the in-app tour copy and the 3.3 release notes, in English, German and French.', owner: 'analyst', dependsOn: ['collab-req'] };

function cycleCollaboration(x: Ctx): void {
  const { b } = x;
  b.human(
    'Quire 3.2 is out: 61 teams upgraded in the first week and Alex has stopped writing invoices by hand. Next is 3.3, collaboration. Today two people editing the same document overwrite each other and we tell customers to take turns. I want real-time co-editing, comments with @mentions and sharing a single document with an outside reviewer. Six weeks, same team.',
  );
  b.replan({
    workstreams: Object.values(COLLAB_WS),
    contracts: [
      { id: 'c-collab-req-tests', from: 'collab-req', to: 'collab-tests', spec: 'Stories are numbered COL-nn with acceptance checklists that the test plan traces one to one; every result names the story id and the build number.' },
      { id: 'c-collab-sync-web', from: 'collab-sync', to: 'collab-web', spec: 'One websocket per open document at /v2/docs/{id}/sync, authenticated with the 15-minute access token in the first message; the server checks the member\'s role on connect and on every update and closes with a code from the {code, message, requestId} catalogue when it refuses.' },
      { id: 'c-collab-sync-mobile', from: 'collab-sync', to: 'collab-mobile', spec: 'The same websocket endpoint and messages as the web editor; the apps reconnect with exponential backoff from 1 to 30 seconds.' },
      { id: 'c-collab-ux-web', from: 'collab-ux', to: 'collab-web', spec: 'Figma frames for presence, comments, mentions and the share dialog, using UI kit names; presence colours come from a fixed palette of 12 that meets the accessibility rules.' },
      { id: 'c-collab-sync-infra', from: 'collab-sync', to: 'collab-infra', spec: 'Sync servers expose /healthz, /metrics with sync_lag_seconds and open_documents, and drain open sockets within 30 seconds on SIGTERM.' },
    ],
  });

  x.tasks('collab-req', [
    'the support tickets about overwritten edits, 340 of them last quarter, sorted by team size and document type',
    'interviews with five agencies about how outside reviewers comment today, mostly by exporting a PDF and emailing it back',
    'the stories for two to fifty people editing one document at the same time without losing a keystroke',
    'the presence stories: who is in the document, where their cursor is and what they have selected',
    'the comment stories: threads anchored to a text range, replies, resolve and reopen',
    'the @mention stories, including mentioning someone who cannot open the document yet',
    'the stories for sharing one document with an outside reviewer by email, without a workspace seat',
    'the plan limits: outside reviewers on Free, Team and Business, read from the entitlements response',
    'acceptance checklists for COL-01 to COL-08 with the timings written out',
    'what happens to comments when the anchored text is deleted',
    'the suggestion stories after the owner\'s request',
    'the read_only behaviour during a failed payment for comments and suggestions',
    'a read-through with the support lead of every story against last quarter\'s tickets',
    'the non-goals: no video calls, no chat sidebar, no comments on images in 3.3',
    'a last consistency pass across the stories and the help centre outline',
  ]);
  x.tasks('collab-ux', [
    'a teardown of four editors\' presence and comment patterns, noting which ones lose comments when text moves',
    'presence avatars in the document header with a +N overflow after five people',
    'remote cursors and selections in the twelve presence colours, each with a name label that fades after three seconds',
    'the comment margin on wide screens and the comment sheet on narrow ones',
    'the @mention picker that lists workspace members first and then people the document is shared with',
    'the notification centre with unread mentions and replies grouped by document',
    'the share dialog for a single document, with the role picker and an expiry date for outside reviewers',
    'the suggestion style: insertions underlined in the author\'s colour, deletions struck through, accept and reject on hover',
    'the read_only state of comments during a failed payment',
    'a usability test with six people who co-wrote a meeting note at the same time',
    'the mobile comment sheet and mention notifications',
    'contrast checks of all twelve presence colours against white and the dark theme',
    'the empty states of the comment margin and the notification centre',
    'the redlines for presence and comments on web and mobile',
    'the hand-off notes for QA covering presence, comment and suggestion states',
  ]);
  x.tasks('collab-sync', [
    'a spike comparing an operational transform server with CRDT libraries on our real documents',
    'the Yjs document model mapped onto our block schema: paragraphs, headings, lists, tables and embeds',
    'the websocket endpoint with the access token check in the first message and the role check on connect',
    'persisting updates to an append-only table and compacting them into a snapshot every 500 updates',
    'loading a document from its latest snapshot plus the updates after it, measured at 40 ms for a 200-page document',
    'the presence channel with cursor positions, broadcast at most ten times a second per client',
    'comment threads stored in Postgres and anchored to Yjs relative positions so they survive edits',
    'the @mention notifications and their email fallback',
    'the role check on every incoming update, which drops updates from viewers and commenters',
    'suggestions stored as marked ranges in the Yjs document with an accept and reject operation',
    'the migration that converts the 1.9 million existing documents to Yjs snapshots, in batches of 5,000',
    'backpressure for clients that send updates faster than the server can persist them',
    'load tests with 50 editors in one document and 20,000 documents open at once',
    'the runbook for a stuck document and how to rebuild it from its updates',
    'the final protocol notes for clients',
  ]);
  x.tasks('collab-web', [
    'replacing the editor\'s save-on-blur with the Yjs binding for ProseMirror',
    'the websocket provider with reconnect, resend of pending updates and the role-based close codes',
    'remote cursors and selections in the twelve presence colours',
    'presence avatars in the header with the +N overflow',
    'the comment margin, anchored to Yjs relative positions',
    'the @mention picker backed by the workspace members endpoint',
    'the notification centre with unread counts',
    'the share dialog for a single document',
    'suggestion mode in the editor with accept and reject',
    'the read_only editor and comment state during a failed payment',
    'undo that only undoes the user\'s own changes, not other people\'s',
    'performance checks with 50 cursors in one document',
    'Playwright cases with two and five browsers editing at once',
    'a pass on keyboard access for comments and suggestions',
    'a last visual pass on cursors and the comment margin against the redlines',
  ]);
  x.tasks('collab-mobile', [
    'the Yjs binding for the mobile editor on top of the existing block renderer',
    'the websocket provider with backoff from 1 to 30 seconds and resend after reconnect',
    'presence avatars in the document header',
    'the comment sheet with threads, replies and resolve',
    'mention notifications through APNs and FCM that open the comment directly',
    'the @mention picker in the keyboard accessory bar',
    'showing suggestions from other people with accept and reject for editors',
    'the read_only state during a failed payment',
    'battery measurements with a document open for an hour on a Pixel 6 and an iPhone 12',
    'Detox cases with a second client driven from a test server',
    'a pass on large fonts for the comment sheet',
    'release builds 3.3.0 for TestFlight and the Play internal track, staged to 10% of devices first because of the document migration',
    'checking comments in German and French',
    'the final review of the comment sheet with design',
  ]);
  x.tasks('collab-infra', [
    'the websocket gateway on the existing load balancer, with idle timeouts raised to 120 seconds',
    'routing every connection for one document to the same sync server',
    'the sync server fleet of 6 instances with room to grow to 24',
    'the sync_lag_seconds metric and an alert at 2 seconds for five minutes',
    'draining sockets on deploys within 30 seconds',
    'the Postgres partitioning of the updates table by month',
    'a game day that kills one sync server under load',
    'capacity numbers for 20,000 concurrent editors',
    'the cost estimate for the new fleet, about USD 2,300 a month',
    'per-document rate limits against runaway clients',
    'dashboards for open documents, updates per second and reconnects',
    'the on-call runbook for the gateway',
    'the capacity sign-off for 3.3',
    'the gateway hand-over notes for the on-call rotation',
  ]);
  x.tasks('collab-tests', [
    'tracing COL-01 to COL-08 to test cases',
    'a test harness that drives five browser clients and two simulated phones against one document',
    'network shaping profiles for 3G, 30% packet loss and a 10-second outage',
    'convergence checks that compare every client\'s document after random edits',
    'comment anchor cases with heavy edits around the anchored text',
    'mention notification cases for members, outside reviewers and people without access',
    'share dialog cases for outside reviewers and their expiry dates',
    'suggestion cases for accept, reject and conflicting suggestions',
    'read_only cases during a failed payment',
    'the gateway load test with 20,000 simulated editors',
    'the migration check on a copy of production documents',
    'the regression run on billing and accounts',
    'the release pass on build 3.3.0-rc2',
    'the known-issues list for 3.3, reviewed with support',
    'the 3.3 sign-off notes, with the migration timing for release night',
  ]);

  x.start('collab-req', 'Starting the 3.3 requirements with last quarter\'s overwrite tickets.', 'collab-req: 340 tickets; agencies and outside reviewers; stories COL-nn; limits from entitlements.');
  x.start('collab-sync', 'Starting the sync server with a spike: operational transform against CRDT libraries on our real documents.', 'collab-sync: spike OT vs Yjs/Automerge on 50 real docs; websocket per doc; snapshots; comments in Postgres.', 'c-collab-sync-web');
  x.start('collab-infra', 'Starting the realtime gateway on the existing load balancer.', 'collab-infra: ALB websockets, idle timeout 120 s; route per document; 6 sync servers; sync lag alert.', 'c-collab-sync-infra');
  x.tick('collab-req', 'collab-sync', 'collab-infra');
  x.qa({
    from: 'analyst', ws: 'collab-req', to: 'backend', toWs: 'collab-sync',
    reply: 'Writing the plan limits for outside reviewers.',
    q: 'will the entitlements response tell clients how many outside reviewers a workspace may invite, or should the stories hard-code it per plan?',
    a: 'It will: I am adding outsideReviewers to the features of GET /v2/workspaces/{id}/entitlements (0 on Free, 5 per document on Team, unlimited on Business). Do not hard-code it; pricing will move again.',
  });
  x.tick('collab-req', 'collab-sync');
  x.start('collab-ux', 'Starting the co-editing and comment designs with a teardown of other editors.', 'collab-ux: presence header, 12 presence colours, comment margin, mention picker, share dialog.', 'collab-req');
  x.tick('collab-ux', 'collab-req', 'collab-infra', 'collab-web', 'collab-mobile');
  b.work('backend', 'collab-sync', 'Recording a failed approach (FAIL-OT-SERVER): the operational transform server from the spike diverged on 3 of 50 real documents when tables and lists were edited at the same time, and every new block type would need its own transform functions. We use Yjs, a CRDT, instead: the 50 documents converged in 10,000 random edit runs.', [
    op.failure(
      'A central operational transform server for concurrent edits (FAIL-OT-SERVER).',
      'It diverged on 3 of 50 real documents when tables and nested lists were edited concurrently, and each block type needs hand-written transform functions; the Yjs CRDT converged on all 50 in 10,000 randomized runs.',
      ['collab-sync'],
    ),
    op.decide(
      'Use Yjs for document state, with the existing block schema mapped onto Yjs types and the server persisting Yjs updates and snapshots.',
      'Yjs converges by construction, has ProseMirror and React Native bindings, and lets clients keep working while disconnected.',
      ['Central operational transform server', 'Automerge'],
      ['collab-sync'],
    ),
  ]);
  b.fact('fail-ot-server', 'FAIL-OT-SERVER', ['backend', 'web', 'mobile', 'qa'], {
    question: 'Which approach to concurrent editing was rejected for diverging on real documents?',
    expect: ['operational transform'],
  });
  x.tick('collab-sync', 'collab-req', 'collab-ux');
  x.dv('collab-req', 'First version of the 3.3 collaboration requirements.', 'Co-editing, presence, comments and mentions; COL-01 to COL-06',
    'Co-editing: up to 50 people edit one document at the same time; a keystroke appears for everyone else within 300 ms on a normal connection and nothing typed is ever lost, including during a 10-second outage. Presence shows who is in the document, their cursor and their selection.',
    'Stories: COL-01 edit together; COL-02 see who is here; COL-03 comment on a text range; COL-04 reply and resolve; COL-05 @mention a member; COL-06 share one document with an outside reviewer by email. Outside reviewers per plan come from the entitlements response, never from the client.',
  );
  x.rev('collab-req', false, 'The co-editing stories are good, but COL-06 lets an outside reviewer do what exactly? Read, comment, edit? And what happens to a comment whose text is deleted is not covered; that is a top-5 ticket. Define the document roles and the orphaned comment case.');
  x.tick('collab-req', 'collab-ux');
  x.qa({
    from: 'web', ws: 'collab-web', to: 'backend', toWs: 'collab-sync',
    reply: 'Wiring the share dialog to the API.',
    q: 'what roles can a person have on a single document, and how do they combine with the workspace role, so the dialog offers the right choices?',
    a: 'Three document roles: viewer, commenter and editor (CONTRACT-DOC-ROLES). Workspace members get their workspace role\'s level unless the document narrows it; outside reviewers only get viewer or commenter, never editor. The sync server enforces it with the 3.1 role matrix on connect and on every update. @mobile @qa the same three roles apply to you.',
    also: ['mobile', 'qa'],
  });
  b.fact('contract-doc-roles', 'CONTRACT-DOC-ROLES', ['backend', 'web', 'mobile', 'qa'], {
    question: 'What are the document roles?',
    expect: ['viewer', 'commenter'],
  });
  x.start('collab-web', 'Starting the web side of co-editing: the Yjs binding replaces save-on-blur.', 'collab-web: y-prosemirror binding; websocket provider; cursors; comment margin; share dialog.', 'c-collab-sync-web');
  x.dv('collab-req', 'Added document roles and the orphaned comment rule.', 'Document roles viewer/commenter/editor; orphaned comments; COL-07 and COL-08',
    'Document roles: viewer, commenter and editor, as the sync server enforces them; outside reviewers are viewers or commenters only. COL-07 when the anchored text of a comment is deleted, the thread stays in the margin marked "Text deleted" with a quote of what it was attached to; COL-08 an outside reviewer\'s access expires on the date the sharer sets, at most 90 days.',
  );
  x.rev('collab-req', true, 'Approved as the 3.3 baseline.');
  x.tick('collab-ux', 'collab-infra');
  x.start('collab-mobile', 'Starting mobile co-editing with the Yjs binding for our block renderer.', 'collab-mobile: Yjs binding; websocket provider with backoff; comment sheet; push for mentions.', 'c-collab-sync-mobile');
  x.start('collab-tests', 'Starting the 3.3 test plan with a multi-client harness.', 'collab-tests: 5 browsers + 2 simulated phones; network shaping; convergence checks.', 'c-collab-req-tests');
  x.tick('collab-sync', 'collab-web', 'collab-mobile', 'collab-tests');

  // Change 1: suggestions; no live cursors on mobile
  b.human(
    'Change of scope for 3.3 (CHANGE-SUGGESTION-MODE): our two biggest agency customers and the legal team at Fenwick Partners say comments are not enough; they need suggestion mode, where an edit is proposed and an editor accepts or rejects it, like tracked changes. It has to be in 3.3. To make room, we drop live cursors on mobile: the apps show who is in the document, but no remote cursors or selections.',
  );
  b.fact('change-suggestion-mode', 'CHANGE-SUGGESTION-MODE', ['*'], {
    question: 'Which editing feature beyond comments must be in 3.3? Give only the current value.',
    expect: ['suggestion mode'],
  });
  b.replan({
    workstreams: [
      { ...COLLAB_WS.req, brief: 'Write the 3.3 requirements for real-time co-editing, presence, comments, @mentions, suggestion mode (proposed edits an editor accepts or rejects) and sharing a single document, as stories COL-nn with acceptance checklists.' },
      COLLAB_WS.ux,
      { ...COLLAB_WS.sync, brief: 'Build the Yjs sync server that merges concurrent edits, keeps snapshots, broadcasts presence, stores comments and suggestions, and enforces document roles, behind a websocket endpoint per document.' },
      { ...COLLAB_WS.web, brief: 'Connect the web editor to the sync server: live edits, presence cursors, comment threads, @mentions, suggestion mode with accept and reject, and the share dialog.' },
      { ...COLLAB_WS.mobile, brief: 'Connect the mobile editor to the sync server: live edits, presence avatars without remote cursors, comment threads, viewing and accepting suggestions, and @mention notifications on iOS and Android.' },
      COLLAB_WS.infra,
      COLLAB_WS.tests,
    ],
    contracts: [
      ...b.currentPlan.contracts.filter(c => c.id !== 'c-collab-sync-web' && c.id !== 'c-collab-sync-mobile'),
      { id: 'c-collab-sync-web', from: 'collab-sync', to: 'collab-web', spec: 'One websocket per open document at /v2/docs/{id}/sync carrying binary Yjs updates (CONTRACT-YJS-SYNC): the client sends its state vector on connect, the server answers with the missing updates, then both sides stream updates; awareness messages carry presence. The server snapshots every 500 updates, authenticates with the 15-minute access token and closes with a catalogue code when the document role refuses an update.' },
      { id: 'c-collab-sync-mobile', from: 'collab-sync', to: 'collab-mobile', spec: 'The same Yjs websocket protocol (CONTRACT-YJS-SYNC); the apps send no cursor positions in awareness, only who is present, and reconnect with backoff from 1 to 30 seconds.' },
      { id: 'c-collab-roles-web', from: 'collab-sync', to: 'collab-web', spec: 'Document roles are viewer, commenter and editor; outside reviewers are viewer or commenter only; suggestions can be made by commenters and accepted or rejected by editors.' },
    ],
  });
  b.fact('contract-yjs-sync', 'CONTRACT-YJS-SYNC', ['backend', 'web', 'mobile', 'qa', 'ops'], {
    question: 'What does the document sync websocket carry?',
    expect: ['Yjs'],
  });
  x.dv('collab-req', 'Added suggestion mode and removed remote cursors from mobile.', 'Suggestion mode COL-09 to COL-11; mobile without remote cursors',
    'Suggestion mode: COL-09 a commenter or editor switches to suggesting and every insertion or deletion becomes a suggestion with author and time; COL-10 an editor accepts or rejects one suggestion or all of them; COL-11 two suggestions on the same text are shown side by side and accepting one rejects the other. Mobile shows who is in the document but no remote cursors or selections, and can accept or reject suggestions.',
  );
  x.rev('collab-req', true, 'Approved; it reflects the owner\'s change.');
  x.status('End of week two of 3.3. Status from each of you, please.', ['collab-req', 'collab-ux', 'collab-sync', 'collab-web', 'collab-mobile', 'collab-infra', 'collab-tests']);
  x.tick('collab-ux', 'collab-sync', 'collab-infra', 'collab-web', 'collab-tests');
  x.dv('collab-ux', 'First version of the co-editing, presence and comment designs.', 'Presence, cursors, comment margin, mentions, notifications, share dialog',
    'Presence: up to five avatars in the header with +N after that; remote cursors and selections in twelve presence colours with a name label that fades after three seconds (web only). Comments sit in the right margin on screens wider than 1100 px and in a bottom sheet otherwise; threads show replies, resolve and reopen.',
    'Mentions: typing @ opens a picker with workspace members first, then people the document is shared with; mentioning someone without access offers to share the document as commenter. Share dialog: invite by email with a role picker (viewer, commenter, editor) and an expiry date for outside reviewers.',
  );
  x.rev('collab-ux', false, 'Every @mention sends an email at once: in the usability test one brainstorm with 40 mentions sent the same person 11 emails in five minutes. Batch them. Also three of the twelve presence colours (yellow, lime, cyan) fail contrast on white.', [
    'Mention and reply emails are batched into one digest per person every 10 minutes, at most one email per document per digest; in-app notifications stay immediate (CONV-MENTION-DIGEST).',
  ]);
  b.fact('conv-mention-digest', 'CONV-MENTION-DIGEST', ['backend', 'design', 'web', 'mobile'], {
    question: 'How are mention and reply emails sent out?',
    expect: ['digest', '10 minutes'],
  });
  x.tick('collab-ux', 'collab-mobile', 'collab-tests', 'collab-web');
  x.dv('collab-ux', 'Added suggestions, the email digest and fixed the presence colours.', 'Suggestion style, notification digest, accessible presence colours',
    'Suggestions: insertions are underlined in the author\'s presence colour, deletions struck through, and hovering shows the author, the time and Accept or Reject; a suggesting toggle sits next to the share button. Emails for mentions and replies go out as a digest every 10 minutes. Yellow, lime and cyan are replaced by amber-700, green-700 and teal-700, so all twelve colours pass WCAG 2.2 AA for labels.',
  );
  x.rev('collab-ux', true, 'Approved. The digest and the three new colours fix both findings.');
  x.tick('collab-web', 'collab-tests', 'collab-infra');
  x.tick('collab-sync', 'collab-req', 'collab-web');
  x.qa({
    from: 'mobile', ws: 'collab-mobile', to: 'backend', toWs: 'collab-sync',
    reply: 'Handling expired sessions on the document socket.',
    q: 'the access token expires after 15 minutes but a document can stay open for hours. Does the socket need a new token, and what happens to edits typed while I refresh it?',
    a: 'The server checks the token only on connect, but closes the socket with SESSION_EXPIRED when the session family is revoked. On that close, refresh with the refresh token, reconnect, send the state vector and the server returns what you missed; your unsent Yjs updates stay in the local document and go out after the handshake, so nothing typed is lost.',
  });
  x.record({ id: 'c-collab-session-mobile', from: 'collab-sync', to: 'collab-mobile', spec: 'The document socket checks the access token on connect and closes with SESSION_EXPIRED when the session family is revoked; the client refreshes, reconnects, sends its state vector and then its unsent Yjs updates, so nothing typed is lost.' });
  x.tick('collab-mobile', 'collab-infra', 'collab-tests', 'collab-req', 'collab-sync');
  x.dv('collab-sync', 'First version of the sync server.', 'Yjs websocket per document, snapshots, presence, comments and roles',
    'Protocol: one websocket per open document at /v2/docs/{id}/sync with binary Yjs updates; on connect the client sends its state vector and gets the missing updates, then both sides stream. Updates are appended to a table and compacted into a snapshot every 500 updates; a 200-page document loads in 40 ms. The role check runs on connect and on every update.',
    'Presence and comments: awareness messages carry the user, colour and cursor, broadcast at most ten times a second. Comment threads live in Postgres and are anchored to Yjs relative positions, so they follow the text through edits; deleted anchors keep a quote of the text.',
  );
  x.rev('collab-sync', false, 'When I closed my laptop lid, I stayed in the presence list of the document for two hours, and so did everyone whose browser crashed. Presence needs an expiry that does not depend on a clean disconnect.', [
    'Presence entries expire 30 seconds after the last heartbeat; clients send a heartbeat every 10 seconds while the document is visible, and the server removes silent entries without waiting for a close (CONV-PRESENCE-TTL).',
  ]);
  b.fact('conv-presence-ttl', 'CONV-PRESENCE-TTL', ['backend', 'web', 'mobile'], {
    question: 'After how long does a presence entry expire without a heartbeat?',
    expect: ['30 seconds'],
  });
  x.tick('collab-sync', 'collab-web', 'collab-req', 'collab-mobile');
  x.status('Halfway through 3.3. Short status from each of you, please, and whether the scope still fits in six weeks.', ['collab-req', 'collab-ux', 'collab-sync', 'collab-web', 'collab-mobile', 'collab-infra', 'collab-tests']);
  b.replan({
    workstreams: [...b.currentPlan.workstreams, COLLAB_DOCS],
    contracts: [
      ...b.currentPlan.contracts,
      { id: 'c-collab-docs-tests', from: 'collab-docs', to: 'collab-tests', spec: 'Every help centre article lists the story ids it covers, so QA can check the article against the behaviour of the release build.' },
    ],
  });
  x.tasks('collab-docs', [
    'the help centre outline: co-editing, presence, comments, mentions, suggestions and sharing',
    'the article on suggestion mode with screenshots of accept and reject',
    'the article on sharing one document with an outside reviewer and how expiry works',
    'the in-app tour copy, five steps of at most 90 characters each',
    'the German and French translations with the agency glossary',
    'the 3.3 release notes draft',
    'a check of every collaboration article against build 3.3.0-rc2 with QA',
    'the final copy edit of the tour and the articles',
  ]);
  x.start('collab-docs', 'Starting the collaboration help centre and the in-app tour.', 'collab-docs: articles per story; tour of 5 steps; DE and FR; release notes.', 'c-collab-docs-tests');
  x.tick('collab-sync', 'collab-infra', 'collab-docs');
  x.dv('collab-sync', 'Presence expiry, suggestions and the email digest in the sync server.', 'Presence heartbeats with a 30-second expiry; suggestions; digest emails',
    'Presence: clients send a heartbeat every 10 seconds while the document is visible and entries expire 30 seconds after the last one, without waiting for a close. Suggestions are marked ranges in the Yjs document with author and time; accept and reject are Yjs transactions that only editors may send. Mention and reply emails are queued per person and sent as a digest every 10 minutes.',
  );
  x.rev('collab-sync', true, 'Approved. Clients can build on this protocol.');
  x.tick('collab-web', 'collab-mobile', 'collab-tests', 'collab-req');
  x.qa({
    from: 'ops', ws: 'collab-infra', to: 'backend', toWs: 'collab-sync',
    reply: 'Choosing how the gateway routes documents to sync servers.',
    q: 'must every socket for one document land on the same sync server, or can two servers serve the same document at once?',
    a: 'One server per document: the server holds the live Yjs document in memory and appends updates in order. Two servers would each think they have the latest state until the next snapshot. Route by document id.',
  });
  x.record({ id: 'c-collab-routing', from: 'collab-sync', to: 'collab-infra', spec: 'Exactly one sync server holds a document at a time; the gateway routes every socket of a document to that server by document id, and moves the document only after the server has drained it.' });
  b.work('ops', 'collab-infra', 'Recording a failed approach (FAIL-STICKY-SESSIONS): I first used load balancer sticky sessions with a cookie. People on the same document landed on different sync servers whenever their cookies were set on different days, and after a deploy all sockets of a server reconnected to one neighbour, which then hit 95% CPU. The gateway now routes by document id on a consistent hash ring.', [
    op.failure(
      'Cookie-based sticky sessions on the load balancer to keep a document on one sync server (FAIL-STICKY-SESSIONS).',
      'Stickiness is per browser, not per document, so editors of one document were split across servers, and a drained server moved all its sockets to a single neighbour at 95% CPU; a consistent hash on the document id fixes both.',
      ['collab-infra'],
    ),
  ]);
  b.fact('fail-sticky-sessions', 'FAIL-STICKY-SESSIONS', ['ops', 'backend', 'qa'], {
    question: 'Which routing approach for keeping a document on one sync server was tried and failed?',
    expect: ['sticky sessions', 'cookie'],
  });
  x.tick('collab-infra', 'collab-docs', 'collab-ux', 'collab-web');
  x.dv('collab-web', 'First version of co-editing and comments in the web editor.', 'Yjs editor binding, cursors, comments, mentions, suggestions, share dialog',
    'Editor: save-on-blur is gone; the ProseMirror editor is bound to a Yjs document and synced over the document websocket, with pending updates resent after a reconnect and SESSION_EXPIRED handled by refreshing the token and reconnecting. Undo only undoes the user\'s own changes.',
    'Collaboration: remote cursors and selections in the twelve presence colours, presence avatars with heartbeats every 10 seconds, the comment margin anchored to relative positions, the @mention picker, and suggestion mode with accept and reject for editors. The share dialog offers viewer, commenter and editor, and only viewer or commenter for outside reviewers.',
  );
  x.rev('collab-web', false, 'Co-editing works, but during a failed payment the editor stays editable until the page is reloaded, and comments can still be posted. The 3.2 billing states have to apply live, not only on load.', [
    'Changes to the plan, the billing state or a person\'s role take effect in open sessions within seconds, without a reload.',
  ]);
  x.tick('collab-web', 'collab-sync', 'collab-mobile', 'collab-ux', 'collab-tests');
  x.dv('collab-web', 'Applied the billing state live in the editor.', 'read_only applied live to editing, comments and suggestions',
    'Billing state: the editor subscribes to the billing.changed event on the document socket; when billingState becomes read_only the editor switches to read-only, the comment box and suggesting toggle are disabled and the red bar appears without a reload. Back to active, everything re-enables within a second.',
  );
  x.rev('collab-web', true, 'Approved. Read-only within a second of the billing change is what the contract promises.');
  x.status('Week four of 3.3. Status from each of you, please.', ['collab-req', 'collab-ux', 'collab-sync', 'collab-web', 'collab-mobile', 'collab-infra', 'collab-tests', 'collab-docs']);
  x.tick('collab-mobile', 'collab-tests', 'collab-req', 'collab-ux', 'collab-docs');
  x.qa({
    from: 'qa', ws: 'collab-tests', to: 'ops', toWs: 'collab-infra',
    reply: 'Setting up the gateway load test.',
    q: 'from where can I run 20,000 simulated editors without hitting our own per-document rate limits, and is staging sized for it?',
    a: 'Use the load-test account in the staging VPC: the k6 runners there are exempt from per-IP limits but not per-document limits, so spread the editors over 2,000 documents. I will scale staging to the production size of 6 sync servers for Thursday.',
  });
  x.tick('collab-infra', 'collab-docs', 'collab-ux', 'collab-req', 'collab-tests', 'collab-web');
  x.dv('collab-infra', 'First version of the realtime gateway and capacity plan.', 'Gateway routing by document id, 6-server fleet, lag alerts',
    'Gateway: websocket connections go through the load balancer to a small routing tier that hashes the document id onto a consistent hash ring of sync servers, so every socket of one document reaches the same server; a drained server\'s documents spread over all others. Idle timeouts are 120 seconds; heartbeats keep sockets alive.',
    'Capacity: 6 sync servers (c7g.xlarge) hold 20,000 concurrent editors at 41% CPU in the staging load test; the fleet can grow to 24. Alerts fire when sync_lag_seconds exceeds 2 for five minutes; the updates table is partitioned by month. Cost is about USD 2,300 a month.',
  );
  x.rev('collab-infra', true, 'Approved. 41% CPU at 20,000 editors leaves room for the first months.');
  x.tick('collab-sync', 'collab-web', 'collab-mobile', 'collab-tests', 'collab-ux');
  x.dv('collab-mobile', 'First version of co-editing and comments in the apps.', 'Yjs binding, presence without cursors, comment sheet, suggestions, mention pushes',
    'Editor: the block renderer is bound to a Yjs document synced over the same websocket protocol as the web; reconnects back off from 1 to 30 seconds and resend unsent updates after the state vector handshake. Presence shows avatars only, no remote cursors, and heartbeats stop when the app is in the background.',
    'Comments and suggestions: the comment sheet shows threads with replies and resolve; suggestions from others are shown inline and editors can accept or reject them. Mention notifications arrive through APNs and FCM and open the thread directly; during read_only the sheet is read-only.',
  );
  x.rev('collab-mobile', false, 'With a document open for an hour the iPhone lost 14% battery, against 4% for a plain document. Something keeps the radio busy.');
  x.tick('collab-mobile', 'collab-tests', 'collab-docs');
  x.dv('collab-mobile', 'Cut the battery cost of open documents.', 'Batched updates and quiet sockets in the background; 5% per hour',
    'Battery: local updates are batched every 250 ms instead of sent per keystroke, awareness is sent only when presence changes, and the socket closes 30 seconds after the app goes to the background and reconnects on return. An hour with an open document now costs 5% on the iPhone 12 and 6% on the Pixel 6.',
  );
  x.rev('collab-mobile', true, 'Approved. 5% an hour is in line with a plain document.');
  x.tick('collab-ux', 'collab-req', 'collab-infra');
  x.dv('collab-docs', 'First version of the collaboration help centre and tour.', 'Help centre articles, in-app tour and 3.3 release notes',
    'Articles (each lists its stories): editing together (COL-01, COL-02), comments and replies (COL-03, COL-04, COL-07), mentions and the 10-minute email digest (COL-05), suggestion mode (COL-09 to COL-11), and sharing one document with an outside reviewer (COL-06, COL-08). German and French use the agency glossary.',
    'In-app tour: five steps of at most 90 characters, shown once to members who open a shared document for the first time. Release notes lead with co-editing and suggestion mode and say that mobile shows who is in a document without live cursors.',
  );
  x.rev('collab-docs', true, 'Approved. Listing story ids per article lets QA check them in one pass.');
  x.tick('collab-tests', 'collab-ux', 'collab-sync', 'collab-mobile', 'collab-docs', 'collab-infra');
  x.status('Last week of 3.3. One line each on what is left, please.', ['collab-req', 'collab-ux', 'collab-sync', 'collab-web', 'collab-mobile', 'collab-infra', 'collab-tests', 'collab-docs']);
  x.tick('collab-tests', 'collab-req', 'collab-web', 'collab-infra', 'collab-mobile', 'collab-sync');
  x.dv('collab-tests', 'First version of the 3.3 test plan and the first run.', 'Plan traced to COL-01..COL-11; convergence harness; first run',
    'Plan: COL-01 to COL-11 trace to 84 automated cases; the harness drives five browsers and two simulated phones on one document under 3G, 30% loss and a 10-second outage, and compares every client\'s document after each run.',
    'First run, COL-01 / build 3.3.0-rc1: 81 of 84 pass. Failures: COL-11 / build 3.3.0-rc1, accepting one of two overlapping suggestions leaves the other visible until reload; COL-07 / build 3.3.0-rc1, a comment on a deleted table cell loses its quote; one flaky presence wait.',
  );
  x.rev('collab-tests', false, 'Good harness. But nothing covers the migration of existing documents to Yjs, and that touches every customer on release day. Run it on a copy of production first.');
  x.tick('collab-tests', 'collab-ux', 'collab-web', 'collab-req', 'collab-mobile', 'collab-sync', 'collab-docs', 'collab-infra');
  x.dv('collab-tests', 'Added the migration check and the gateway load test; release pass on rc2.', 'Migration check on 1.9 million documents; load test; release pass on 3.3.0-rc2',
    'Migration check: all 1.9 million documents of a production copy were converted to Yjs snapshots in 3 h 40 min; 1,912 documents with malformed tables were repaired and 3 kept as read-only originals for support. Load test: 20,000 simulated editors on 2,000 documents, p95 sync latency 140 ms, no lost update.',
    'Release pass on build 3.3.0-rc2: 84 of 84 automated cases pass, including COL-11 / build 3.3.0-rc1 and COL-07 / build 3.3.0-rc1, now fixed. Known issue: COL-05 / build 3.3.0-rc2, the digest email shows times in UTC for people who never set a time zone.',
  );
  x.rev('collab-tests', true, 'Approved for release; the migration runs on release night as tested.');
  x.close('collab-');
}

// ===========================================================================
// Cycle 4: offline (Quire 3.4)
// ===========================================================================

const OFF_WS = {
  req: { id: 'off-req', title: 'Offline requirements', brief: 'Write the 3.4 requirements for reading pinned documents without a connection on web, desktop and mobile, as stories OFF-nn with acceptance checklists.', owner: 'analyst', dependsOn: [] },
  ux: { id: 'off-ux', title: 'Offline states and pinning UX', brief: 'Design pinning, the offline indicators, storage settings and what each screen shows without a connection, on web, desktop and mobile.', owner: 'design', dependsOn: ['off-req'] },
  sync: { id: 'off-sync', title: 'Offline sync service', brief: 'Extend the sync server so clients that were away for minutes or weeks catch up efficiently, and serve compact snapshots of pinned documents.', owner: 'backend', dependsOn: ['off-req'] },
  web: { id: 'off-web', title: 'Offline web app', brief: 'Make the web app open and show pinned documents without a connection: a service worker for the app shell and local storage of document snapshots.', owner: 'web', dependsOn: ['off-ux', 'off-sync'] },
  desktop: { id: 'off-desktop', title: 'Desktop app', brief: 'Package the web app as an Electron desktop app for macOS and Windows with pinned documents stored on disk and automatic updates.', owner: 'web', dependsOn: ['off-web'] },
  mobile: { id: 'off-mobile', title: 'Offline mobile apps', brief: 'Store pinned documents on the device in the iOS and Android apps and show them without a connection.', owner: 'mobile', dependsOn: ['off-ux', 'off-sync'] },
  sec: { id: 'off-sec', title: 'Offline data security', brief: 'Encrypt documents stored on devices, wipe them on sign-out or removal from a workspace, and define what admins can enforce for offline storage.', owner: 'ops', dependsOn: ['off-req'] },
  tests: { id: 'off-tests', title: 'Offline test plan and release pass', brief: 'Write the 3.4 test plan, automate offline and reconnect scenarios on every platform and run the release pass.', owner: 'qa', dependsOn: ['off-web', 'off-mobile', 'off-sync'] },
} satisfies Record<string, Ws>;

function cycleOffline(x: Ctx): void {
  const { b } = x;
  b.human(
    'Quire 3.3 is out and co-editing is the most used feature we have ever shipped: 70% of active documents had two or more editors last week. Next is 3.4, offline. Consultants and field engineers tell us they open Quire on trains and at client sites with no signal and get a blank page. For 3.4 they must at least be able to read the documents they need, on the web, a desktop app and the phones. Same rhythm as before, please.',
  );
  b.replan({
    workstreams: Object.values(OFF_WS),
    contracts: [
      { id: 'c-off-req-tests', from: 'off-req', to: 'off-tests', spec: 'Stories are numbered OFF-nn with acceptance checklists that the test plan traces one to one; every result names the story id and the build number.' },
      { id: 'c-off-sync-web', from: 'off-sync', to: 'off-web', spec: 'GET /v2/docs/{id}/snapshot returns the latest compacted Yjs snapshot of a document with its state vector; clients store it and open the document from it without a connection.' },
      { id: 'c-off-sync-mobile', from: 'off-sync', to: 'off-mobile', spec: 'The same snapshot endpoint; the apps fetch snapshots of pinned documents on launch, on the doc.updated push and when the device comes back online.' },
      { id: 'c-off-web-desktop', from: 'off-web', to: 'off-desktop', spec: 'The desktop app loads the same web build and service worker; it stores pinned snapshots on disk instead of the browser store.' },
      { id: 'c-off-sec-clients', from: 'off-sec', to: 'off-mobile', spec: 'Stored documents are encrypted with a per-device key held in the Keychain or Keystore; the key is destroyed on sign-out, on removal from the workspace and on a remote wipe.' },
    ],
  });

  x.tasks('off-req', [
    'the 41 support tickets about blank pages without a connection, tagged by platform; 26 are from consultants on trains and at client sites who had the document open an hour earlier',
    'interviews with six field engineers about what they open offline: checklists, site reports and procedures, rarely more than 20 documents, and most of them want to fill a checklist in on site',
    'the pinning stories: pin a document or a folder for offline use, see what is pinned on this device, unpin to free space, with a folder pin including new documents added later',
    'the stories for opening a pinned document without a connection, including images and attachments, and what a link to an unpinned document shows instead of a blank page',
    'the plan limits for pinned documents per device, read from the offlineDocs feature of the entitlements response rather than written into the clients',
    'the editing stories after the owner\'s change: typing, checklists, comments and suggestions without a connection, and what the person sees when they come back online',
    'the stories for losing access while offline: removed from the workspace, role reduced to commenter, or the workspace becoming read_only because of a failed payment',
    'what happens when a device has been offline for longer than the 30-day life of a refresh token, written so that nothing typed is lost even if the person has to sign in again',
    'acceptance checklists for OFF-01 to OFF-10 with sizes and timings written out, for example a 50-page document with 20 images opening in under 2 seconds from local storage',
    'the installable web app stories that replace the desktop app, including installation from Chrome and Edge and how updates arrive',
    'a read-through of every story with two field engineers on a video call, who added the case of a checklist ticked on two phones offline at the same site',
    'the storage rules for shared computers, where pinned documents must not stay after sign-out',
    'the non-goals: no offline search across unpinned documents, no offline creation of new workspaces, no offline sharing with outside reviewers in 3.4',
    'a last consistency pass across the stories and the plan limits',
    'the release notes outline for 3.4',
  ]);
  x.tasks('off-ux', [
    'an audit of every screen in the web and mobile apps without a connection: 14 screens show a spinner forever and 3 show a raw network error',
    'the pin action in the document menu and on folders, with the size the pin will take on this device shown before confirming',
    'the offline banner, which appears after 3 seconds without a connection and does not cover the document title',
    'the per-document indicator in lists and in the editor header: synced, saved on this device, waiting to sync with a count of changes, or needs attention',
    'the storage settings page with the list of pinned documents, their sizes and the total against the device limit',
    'the "not available offline" page for links to unpinned documents, with a pin-for-next-time button',
    'the reconnect moment: a quiet "All changes synced" toast, and a visible note when someone else changed the same paragraph',
    'the state shown to someone whose role was reduced while offline, where their edits became suggestions',
    'the read_only state reached while offline, where local edits are kept as a private copy instead of being dropped',
    'the sign-in sheet shown after more than 30 days offline, which keeps the unsynced changes visible under it',
    'a usability test with five field engineers who filled in a site checklist in airplane mode and then reconnected',
    'contrast checks of the four sync indicators on light and dark themes and on the low-brightness settings people use in the field',
    'the install prompt for the web app on Chrome and Edge',
    'the redlines for the sync states and pinning on web and mobile',
    'the hand-off notes for QA with every offline state listed',
  ]);
  x.tasks('off-sync', [
    'measuring how far behind clients really are: the median reconnect is 4 minutes behind, but 3% of devices come back after more than two weeks with thousands of missed updates',
    'GET /v2/docs/{id}/snapshot with the compacted Yjs snapshot and its state vector, served gzip-compressed and cached by the CDN with the snapshot id as the cache key',
    'the reconnect handshake for long absences: when a client\'s state vector is older than the oldest kept update, the server sends a full snapshot instead of thousands of updates',
    'accepting large batches of offline updates without blocking other editors of the document, by applying them in chunks of at most 1 MB; a week-old batch merges without a central server, which the operational transform design we dropped in 3.3 could not have done',
    're-checking the document role for every queued update after reconnect, so edits from someone reduced to commenter while offline are turned into suggestions instead of being applied',
    'the read_only rule for offline edits: edits made before the workspace became read_only are applied, later ones are returned to the client to keep as a private copy',
    'the doc.updated silent push for pinned documents, at most one per document per minute',
    'the attachment upload queue for images added offline, with an idempotency key per file so a retried upload is stored once',
    'keeping 30 days of updates per document instead of 7, which raises the updates table by about 180 GB',
    'load tests with 2,000 devices reconnecting at 9:00 after a night offline, the pattern the field teams create every morning',
    'a metric for the size of reconnect batches and an alert when a document receives more than 50 MB of offline updates in an hour',
    'the error codes for the resync path, added to the existing error catalogue so clients can tell a full resync from a refused update',
    'the runbook for a device that keeps sending the same rejected batch',
    'the protocol notes for web and mobile engineers',
    'the final API document for snapshots and resync',
  ]);
  x.tasks('off-web', [
    'the service worker that caches the app shell, fonts and the editor bundle, with a versioned cache that is swapped only after the new version has fully downloaded',
    'storing pinned documents in localStorage as base64 Yjs snapshots, which was the quickest path to a working prototype',
    'moving pinned documents to IndexedDB through y-indexeddb, one database per workspace, with the snapshot and every local update stored separately',
    'opening a pinned document from IndexedDB in 600 ms for a 50-page document, before the websocket has even connected',
    'the offline banner and the per-document sync indicator, driven by the provider\'s connection state and the count of unsent updates',
    'the "not available offline" route for unpinned documents, which keeps the URL so the page loads normally once the connection is back',
    'editing without a connection: the Yjs document keeps local updates in IndexedDB and the provider sends them after the state vector handshake',
    'the storage settings page with sizes per pinned document, read from the browser storage estimate',
    'the web app manifest, icons and install prompt for Chrome and Edge, replacing the desktop app',
    'clearing every IndexedDB database of a workspace on sign-out and on a WORKSPACE_ACCESS_REVOKED close from the server',
    'handling a refresh token that expired while offline: the sign-in sheet opens and unsent updates stay in IndexedDB until the session is back',
    'Playwright cases that switch the browser offline, edit, reload and come back online',
    'the bundle and cache size checks after adding the service worker',
    'a pass on keyboard access for the pin action and the storage settings',
    'a last visual pass on the four sync states against the redlines',
  ]);
  x.tasks('off-desktop', [
    'an Electron shell around the web build with the same service worker',
    'disk storage for pinned snapshots under the user profile',
    'automatic updates from a signed feed for macOS and Windows',
    'code signing with the company certificates on both platforms',
  ]);
  x.tasks('off-mobile', [
    'storing pinned documents in the app\'s SQLite database as Yjs snapshots plus local updates, encrypted with SQLCipher and a key from the Keychain or Keystore',
    'fetching snapshots of pinned documents on launch and on the doc.updated push, limited to Wi-Fi for documents larger than 20 MB unless the user allows mobile data',
    'opening a pinned document from SQLite in under a second on a Pixel 4a, the slowest phone the field engineers still use',
    'relying on iOS background app refresh to keep pinned documents fresh overnight, which turned out not to work',
    'syncing pinned documents when the app comes to the foreground and on silent pushes, and showing the age of each pinned copy',
    'editing without a connection: local Yjs updates are written to SQLite before they are applied to the screen, so a crash never loses a keystroke',
    'the per-document sync indicator and the offline banner in the editor header',
    'checklist items ticked offline on two phones at the same site, which Yjs merges without asking anyone',
    'the storage screen with sizes and an "Unpin all on this device" action',
    'the sign-in sheet after more than 30 days offline, with the unsynced changes kept in SQLite',
    'wiping every pinned document and the encryption key on sign-out and on removal from the workspace',
    'Detox cases with airplane mode toggled from the test runner on both platforms',
    'battery and storage measurements for 50 pinned documents with images',
    'release builds 3.4.0 for TestFlight and the Play internal track, with the encrypted store tested on an upgrade from 3.3',
    'the final review of the offline states with design',
  ]);
  x.tasks('off-sec', [
    'the threat model for documents stored on lost, stolen or shared devices, including a laptop in a hotel business centre that the next guest uses',
    'encryption at rest on mobile with SQLCipher and a per-device key in the Keychain (after first unlock) or the Android Keystore',
    'what the browser can protect: IndexedDB is not encrypted at rest by the browser, so the web app relies on the operating system disk encryption and short-lived storage on shared computers',
    'the wipe rules: sign-out, removal from the workspace, a remote wipe by an admin and 30 days without a successful sync all delete pinned documents and keys',
    'an admin setting to turn offline storage off per workspace, read by every client from the entitlements response',
    'the audit trail rows for pins, unpins and remote wipes, kept with the other security events',
    'a review of the service worker scope and cache rules, so that no API response with personal data is cached by accident',
    'a test of the wipe on a removed member\'s iPhone and Android phone, both offline at the time of removal',
    'the guidance for customers whose devices are managed with MDM, including the app config keys Intune and Jamf can set',
    'the penetration test scope for offline storage',
    'the fix list for 3.4 from the penetration test',
    'the offline storage security sign-off for 3.4',
    'the hand-over notes for support',
  ]);
  x.tasks('off-tests', [
    'tracing OFF-01 to OFF-12 to test cases',
    'device profiles for the test lab: a Pixel 4a on Android 12, an iPhone SE, a Windows laptop with Edge and a MacBook with Chrome, each able to cut the network on command',
    'cases for opening pinned documents with images in airplane mode on every profile',
    'offline editing cases with two devices editing the same paragraph and the same checklist while both are offline',
    'long-absence cases with a device kept offline for 35 days using a test clock on the server',
    'role and billing cases while offline: reduced to commenter, removed from the workspace, workspace read_only',
    'storage limit cases at the plan limit and at the 200 MB per device limit',
    'wipe cases for sign-out, removal and remote wipe while the device is offline',
    'the morning reconnect load test with 2,000 devices',
    'install and update cases for the web app on Chrome and Edge',
    'the regression run on co-editing, billing and accounts',
    'the release pass on build 3.4.0-rc2',
    'the known-issues list for 3.4 with a workaround for each item',
    'the 3.4 sign-off notes, with the device lab results per profile',
  ]);

  x.start('off-req', 'Starting the 3.4 offline requirements with the 41 blank-page tickets and the field engineer interviews.', 'off-req: pinned docs; read offline on web, desktop, mobile; stories OFF-nn; limits from entitlements.');
  x.start('off-sync', 'Starting the offline sync work by measuring how far behind real clients are when they reconnect.', 'off-sync: snapshot endpoint; long-absence resync; 30-day update retention; doc.updated push.', 'c-off-sync-web');
  x.start('off-sec', 'Starting the offline data security work with the threat model for lost and shared devices.', 'off-sec: SQLCipher on mobile; browser storage limits; wipe rules; admin switch; audit rows.', 'c-off-sec-clients');
  x.tick('off-req', 'off-sync', 'off-sec');
  x.qa({
    from: 'analyst', ws: 'off-req', to: 'backend', toWs: 'off-sync',
    reply: 'Writing the plan limits for pinned documents.',
    q: 'can the entitlements response carry the number of documents a device may pin, so the clients never hard-code it per plan the way they almost did with outside reviewers?',
    a: 'Yes: I am adding offlineDocs to the features of GET /v2/workspaces/{id}/entitlements: 5 on Free, 50 on Team, 200 on Business, and 0 when an admin turns offline storage off. Clients read it like every other feature.',
  });
  x.record({ id: 'c-off-limits-web', from: 'off-sync', to: 'off-web', spec: 'The entitlements response lists offlineDocs, the number of documents one device may pin: 5 on Free, 50 on Team, 200 on Business, and 0 when an admin turns offline storage off. Clients never hard-code it.' });
  x.tick('off-req', 'off-sync', 'off-sec');
  x.start('off-ux', 'Starting the offline states by walking every screen with the network switched off.', 'off-ux: audit 14 spinner screens; pin action with size; banner after 3 s; per-doc indicator; storage page.', 'off-req');
  x.start('off-web', 'Starting the offline web app with the service worker for the app shell.', 'off-web: service worker with versioned cache; pinned snapshots stored locally; offline banner; storage settings.', 'c-off-sync-web');
  x.tick('off-ux', 'off-web', 'off-req');
  x.dv('off-req', 'First version of the 3.4 offline requirements: pinning and reading without a connection on every platform. The plan limits come from the entitlements response.', 'Pinning and offline reading; OFF-01 to OFF-06',
    'Pinning: OFF-01 pin a document or a folder for offline use on this device; a folder pin includes documents added later. OFF-02 see what is pinned and how much space it takes; OFF-03 unpin to free space. The number of pinned documents per device comes from the offlineDocs feature (5 on Free, 50 on Team, 200 on Business).',
    'Reading without a connection: OFF-04 open a pinned document, with its images, in under 2 seconds on web, desktop and mobile; OFF-05 a link to an unpinned document shows "Not available offline" with the title, never a blank page; OFF-06 pinned copies refresh within a minute of a change while the device is online.',
  );
  x.rev('off-req', true, 'Approved as the starting point. Keep the limits in the entitlements response, as written.');
  x.tick('off-sync', 'off-sec', 'off-ux', 'off-web');

  // Change 1: editing offline, not only reading
  b.human(
    'Change of requirements after the site visits (CHANGE-OFFLINE-EDITING): reading is not enough. The field engineers fill in inspection checklists and site reports at the client, with no signal, and today they do it on paper and type it up at night. In 3.4 people must be able to edit pinned documents offline, including checklists and comments, and everything has to merge when they come back online. Please replan around offline editing rather than read-only offline.',
  );
  b.fact('change-offline-editing', 'CHANGE-OFFLINE-EDITING', ['*'], {
    question: 'What offline capability must 3.4 provide? Give only the current value.',
    expect: ['offline editing', 'edit pinned documents offline'],
  });
  b.replan({
    workstreams: b.currentPlan.workstreams.map(w =>
      w.id === 'off-req'
        ? { ...w, brief: 'Write the 3.4 requirements for pinning documents and editing them without a connection on web, desktop and mobile, including checklists, comments and what happens on reconnect, as stories OFF-nn with acceptance checklists.' }
        : w.id === 'off-sync'
          ? { ...w, brief: 'Extend the sync server for offline editing: clients that were away for minutes or weeks send their local updates and catch up efficiently, roles and billing state are re-checked for queued updates, and pinned documents have compact snapshots.' }
          : w.id === 'off-web'
            ? { ...w, brief: 'Make the web app open and edit pinned documents without a connection: a service worker for the app shell, local storage of snapshots and unsent updates, and sync on reconnect.' }
            : w.id === 'off-mobile'
              ? { ...w, brief: 'Store pinned documents on the device in the iOS and Android apps, let people edit them without a connection and sync every local change on reconnect.' }
              : w,
    ),
    contracts: [
      ...b.currentPlan.contracts,
      { id: 'c-off-resync-web', from: 'off-sync', to: 'off-web', spec: 'Reconnect after offline editing (CONTRACT-STATE-VECTOR-RESYNC): the client sends its Yjs state vector and then its local updates in batches of at most 1 MB; the server answers with the updates the client is missing, or with a full snapshot when the state vector is older than the 30 days of kept updates. Updates the current document role does not allow come back as suggestions; updates refused because of read_only come back in a REJECTED_OFFLINE_EDITS message for the client to keep as a private copy.' },
      { id: 'c-off-resync-mobile', from: 'off-sync', to: 'off-mobile', spec: 'The same resync handshake, batches and REJECTED_OFFLINE_EDITS message as the web app; the apps send their batches only after the state vector exchange has finished.' },
    ],
  });
  b.fact('contract-state-vector-resync', 'CONTRACT-STATE-VECTOR-RESYNC', ['backend', 'web', 'mobile', 'qa'], {
    question: 'What does the client send first when it reconnects after offline editing?',
    expect: ['state vector'],
  });
  x.dv('off-req', 'Added the offline editing stories after the owner\'s change, including what happens when someone loses access or their session while away.', 'Offline editing OFF-07 to OFF-10; losing access while offline',
    'Offline editing: OFF-07 edit text and tick checklist items in a pinned document without a connection; OFF-08 add comments and suggestions offline; OFF-09 on reconnect every local change is sent and merged without asking, and the person sees "All changes synced". Two people ticking the same checklist offline end with the same ticks on both devices.',
    'Losing access while offline: OFF-10 if the person\'s role was reduced to commenter, their offline edits arrive as suggestions; if the workspace became read_only, their edits are kept on the device as a private copy they can export; if they were removed, the device deletes the documents on reconnect. After more than 30 days offline the person signs in again and nothing typed is lost.',
  );
  x.rev('off-req', false, 'The editing stories are right, but storage is unbounded: a folder pin on a 3,000-document folder would fill a phone. Put a hard limit per device in the stories, and say what happens when it is reached.', [
    'Offline storage is capped per device at the plan\'s offlineDocs count and at most 200 MB; when a pin would exceed either cap the client says so before pinning, and folder pins stop adding documents at the cap (CONV-OFFLINE-PIN-LIMIT).',
  ]);
  b.fact('conv-offline-pin-limit', 'CONV-OFFLINE-PIN-LIMIT', ['mobile', 'web', 'design', 'qa', 'analyst'], {
    question: 'What caps offline storage per device?',
    expect: ['offlineDocs', '200 MB'],
  });
  x.tick('off-req', 'off-sync', 'off-mobile');
  x.start('off-mobile', 'Starting the offline apps with an encrypted SQLite store for pinned documents.', 'off-mobile: SQLCipher store of snapshots + local updates; fetch on launch and push; edit offline; wipe rules.', 'c-off-resync-mobile');
  x.start('off-tests', 'Starting the 3.4 test plan with device profiles that can cut the network on command.', 'off-tests: Pixel 4a, iPhone SE, Windows/Edge, MacBook/Chrome; offline toggles; server test clock for long absences.', 'c-off-req-tests');
  x.start('off-desktop', 'Starting the desktop app as an Electron shell around the web build.', 'off-desktop: Electron shell; pinned snapshots on disk; signed auto-updates; code signing.', 'c-off-web-desktop');
  x.tick('off-ux', 'off-web', 'off-sec', 'off-tests');
  x.dv('off-req', 'Added the per-device storage cap to the pinning stories.', 'Per-device cap: offlineDocs and 200 MB',
    'Storage cap: a device keeps at most the plan\'s offlineDocs count of pinned documents and at most 200 MB; the pin action shows the size before confirming and refuses a pin that would pass either cap, and a folder pin stops adding documents at the cap and says how many were left out.',
  );
  x.rev('off-req', true, 'Approved; this is the 3.4 baseline.');
  x.tick('off-web', 'off-desktop', 'off-sync', 'off-mobile');
  b.work('web', 'off-web', 'Recording a failed approach (FAIL-LOCALSTORAGE-QUOTA): my first prototype kept pinned documents in localStorage as base64 Yjs snapshots. Safari and Firefox stop at 5 MB per origin, so the eleventh pinned document failed silently, and every write blocked the main thread for up to 300 ms while typing. Pinned documents and unsent updates now live in IndexedDB through y-indexeddb.', [
    op.failure(
      'Keeping pinned documents and unsent updates in localStorage as base64 Yjs snapshots (FAIL-LOCALSTORAGE-QUOTA).',
      'Browsers cap localStorage at about 5 MB per origin, so pins failed silently after about ten documents, and its synchronous writes blocked typing for up to 300 ms; IndexedDB has room and is asynchronous.',
      ['off-web'],
    ),
  ]);
  b.fact('fail-localstorage-quota', 'FAIL-LOCALSTORAGE-QUOTA', ['web', 'qa', 'ops'], {
    question: 'Where did the first prototype keep pinned documents, which failed?',
    expect: ['localStorage'],
  });
  x.tick('off-web', 'off-mobile', 'off-ux', 'off-req');
  x.qa({
    from: 'mobile', ws: 'off-mobile', to: 'backend', toWs: 'off-sync',
    reply: 'Planning the reconnect order on the phone.',
    q: 'after a day offline, should the app send its local updates first or ask for the missing ones first? And how big may one batch be?',
    a: 'State vector first, then your batches: the server needs your state vector to send what you are missing, and your local updates go after it in batches of at most 1 MB (CONTRACT-STATE-VECTOR-RESYNC). If the server answers with a full snapshot because you were away more than 30 days, apply it and then send your batches; Yjs merges them on top.',
  });
  x.tick('off-sync', 'off-sec', 'off-tests', 'off-req');
  x.dv('off-ux', 'First version of the offline designs: pinning with sizes, the banner, per-document indicators, storage settings and the not-available page.', 'Pinning, offline banner, indicators, storage settings',
    'Pinning: "Make available offline" in the document and folder menus shows the size on this device before confirming and refuses a pin past the device cap with the reason. The offline banner appears after 3 seconds without a connection, under the document title, in grey.',
    'Storage settings: pinned documents with their sizes, the total against the device cap and "Unpin all on this device". Links to unpinned documents open a page with the title and "Not available offline", plus "Pin for next time" that queues the pin.',
  );
  x.rev('off-ux', false, 'The designs show offline and online, but not what matters most to the engineers: whether their own changes are safe. In the test two people thought their checklist was lost because nothing said it was waiting to sync. Every document needs a visible state.', [
    'Every document shows its sync state wherever it appears (lists, editor header, pinned list): synced, saved on this device, waiting to sync with the number of changes, or needs attention; the state is never shown by colour alone (CONV-SYNC-STATE-VISIBLE).',
  ]);
  b.fact('conv-sync-state-visible', 'CONV-SYNC-STATE-VISIBLE', ['design', 'web', 'mobile', 'qa'], {
    question: 'What must every document show wherever it appears?',
    expect: ['sync state'],
  });
  x.tick('off-ux', 'off-web', 'off-desktop', 'off-sync', 'off-mobile');
  x.status('Two weeks into 3.4. Status from each of you, please, and say whether your estimate still holds.', ['off-req', 'off-ux', 'off-sync', 'off-web', 'off-desktop', 'off-mobile', 'off-sec', 'off-tests']);

  // Change 2: installable web app instead of a desktop app
  b.human(
    'One more change for 3.4 (CHANGE-PWA-NOT-DESKTOP): we drop the Electron desktop app. Signing, notarising and auto-updating it for macOS and Windows would cost us a person for every release, and the field teams said an installable web app from Chrome or Edge is fine on their laptops. Please fold what the desktop app was meant to do into the web app as an installable web app with offline support.',
  );
  b.fact('change-pwa-not-desktop', 'CHANGE-PWA-NOT-DESKTOP', ['web', 'design', 'qa', 'analyst', 'ops'], {
    question: 'How are field teams served on their laptops now? Give only the current value.',
    expect: ['installable web app'],
  });
  b.replan({
    workstreams: b.currentPlan.workstreams
      .filter(w => w.id !== 'off-desktop')
      .map(w =>
        w.id === 'off-web'
          ? { ...w, brief: 'Make the web app an installable web app (Chrome and Edge) that opens and edits pinned documents without a connection: a service worker for the app shell, IndexedDB for snapshots and unsent updates, and sync on reconnect. It replaces the desktop app.' }
          : w.id === 'off-ux'
            ? { ...w, brief: 'Design pinning, the sync state of every document, storage settings, the install prompt of the web app and what each screen shows without a connection, on web and mobile.' }
            : w,
      ),
    contracts: b.currentPlan.contracts.filter(c => c.id !== 'c-off-web-desktop'),
  });
  x.tick('off-ux', 'off-req', 'off-mobile', 'off-web', 'off-sync');
  x.qa({
    from: 'design', ws: 'off-ux', to: 'web', toWs: 'off-web',
    reply: 'Designing the install prompt for the web app.',
    q: 'can the web app tell whether it is already installed, so the prompt is not shown to people who installed it, and can it show its own button instead of the browser\'s bar?',
    a: 'Yes on Chrome and Edge: we catch beforeinstallprompt and show our own button in the sidebar, and display-mode standalone tells us it runs installed. Safari has no install event, so on Safari we only show a short help link.',
  });
  x.dv('off-ux', 'Added the sync state to every document, the install prompt and the access-loss states.', 'Sync state everywhere; install prompt; read_only and role changes while offline',
    'Sync state: lists, the editor header and the pinned list show one of four states with an icon and a word: Synced, Saved on this device, Waiting to sync (3 changes), Needs attention. Needs attention opens a sheet: edits turned into suggestions after a role change, or a private copy kept because the workspace became read_only. The install prompt is a sidebar button on Chrome and Edge, hidden once installed.',
  );
  x.rev('off-ux', true, 'Approved. The four states read well in the second test.');
  x.tick('off-sync', 'off-web', 'off-sec', 'off-tests', 'off-req');
  x.dv('off-sync', 'First version of the offline sync service: snapshots, the resync handshake for long absences, chunked offline batches and the role and billing checks on queued updates.', 'Snapshots, long-absence resync, offline batches, re-checked roles',
    'Snapshots: GET /v2/docs/{id}/snapshot returns the compacted Yjs snapshot with its state vector, gzip-compressed and cached by the CDN under the snapshot id. Updates are kept 30 days instead of 7; a client whose state vector is older gets a full snapshot instead of thousands of updates.',
    'Offline batches: local updates arrive in batches of at most 1 MB and are applied in chunks so other editors of the document are not blocked. Every queued update is checked against the current document role and billing state: from a commenter it is stored as a suggestion, during read_only it is returned in REJECTED_OFFLINE_EDITS.',
  );
  x.rev('off-sync', false, 'The handshake is right. But a phone that was offline in a tunnel and retries the same batch three times gets three copies of an image, because attachment uploads are not safe to repeat. The 3.1 rule covers this.');
  x.tick('off-sync', 'off-mobile', 'off-req');
  x.dv('off-sync', 'Made offline attachment uploads safe to repeat and added the resync error codes.', 'Idempotency-Key per attachment; resync error codes',
    'Attachments: each image added offline gets its own Idempotency-Key from the client, so a retried upload after a tunnel stores the file once and returns the same attachment id. Resync errors use the {code, message, requestId} body: SNAPSHOT_REQUIRED, BATCH_TOO_LARGE and WORKSPACE_ACCESS_REVOKED. 2,000 devices reconnecting within one minute peaked at 38% CPU on the sync fleet.',
  );
  x.rev('off-sync', true, 'Approved. One stored file per retried upload, and the error codes tell clients what to do.');
  x.tick('off-web', 'off-sec', 'off-ux', 'off-tests', 'off-mobile');
  x.qa({
    from: 'web', ws: 'off-web', to: 'ops', toWs: 'off-sec',
    reply: 'Deciding what the web app keeps on shared computers.',
    q: 'IndexedDB is not encrypted by the browser. Is it acceptable to keep pinned documents there on a laptop, and what should happen on a shared computer?',
    a: 'Acceptable on a personal laptop with disk encryption, which every customer policy we have seen requires. On a computer the person marks as shared at sign-in, keep nothing after the tab closes: no pins, no service worker document cache. And always wipe on sign-out and on WORKSPACE_ACCESS_REVOKED.',
  });
  x.record({ id: 'c-off-shared-web', from: 'off-sec', to: 'off-web', spec: 'On a computer marked as shared at sign-in the web app keeps nothing after the tab closes: no pinned documents and no document cache in the service worker. Every device wipes the workspace\'s local data on sign-out and on WORKSPACE_ACCESS_REVOKED.' });
  x.tick('off-web', 'off-mobile', 'off-req', 'off-ux');
  x.dv('off-web', 'First version of the offline web app: installable from Chrome and Edge, pinned documents and unsent edits in IndexedDB, and the resync handshake on reconnect.', 'Installable web app; IndexedDB storage; offline editing and resync',
    'Installable web app: a manifest, icons and our own install button on Chrome and Edge; the service worker caches the app shell and editor bundle in a versioned cache that is swapped only after a full download. Pinned documents open from IndexedDB in 600 ms for a 50-page document, before the websocket connects.',
    'Offline editing: local Yjs updates are stored in IndexedDB and sent in batches after the state vector exchange; the sync state shows in lists and in the editor header. Sign-out, WORKSPACE_ACCESS_REVOKED and "this is a shared computer" clear every database of the workspace.',
  );
  x.rev('off-web', false, 'After 35 days offline the laptop showed a sign-in page and the edits I had made were gone from view until I signed in. The 30-day refresh token is expected to run out, but the edits must stay visible and safe while the person signs in.');
  x.tick('off-web', 'off-sec', 'off-sync');
  x.dv('off-web', 'Kept offline edits visible across an expired session.', 'Sign-in sheet over the document; edits kept in IndexedDB',
    'Expired session: when the refresh token was rejected after a long absence, the sign-in sheet opens over the open document, which stays readable with its "Waiting to sync" changes; the unsent updates stay in IndexedDB and are sent after sign-in. Tested with a 35-day absence on a server test clock.',
  );
  x.rev('off-web', true, 'Approved. The edits stay readable while the person signs in, which was the point.');
  x.status('Week four of 3.4. Status from each of you, please.', ['off-req', 'off-ux', 'off-sync', 'off-web', 'off-mobile', 'off-sec', 'off-tests']);
  x.tick('off-mobile', 'off-tests', 'off-ux', 'off-web', 'off-sync');
  b.work('mobile', 'off-mobile', 'Recording a failed approach (FAIL-IOS-BACKGROUND-FETCH): I relied on iOS background app refresh to update pinned documents overnight. Over a week on twelve test iPhones the system ran it at most twice a day, never on phones in Low Power Mode, and not at all for people who rarely open the app, so the morning copy was often a day old. The app now syncs pinned documents on every foreground and on silent pushes, and shows the age of each copy.', [
    op.failure(
      'Keeping pinned documents fresh with iOS background app refresh (BGAppRefreshTask) overnight (FAIL-IOS-BACKGROUND-FETCH).',
      'iOS decides when background refresh runs: at most twice a day in our tests, never in Low Power Mode and rarely for apps opened seldom; syncing on foreground and on silent pushes is predictable.',
      ['off-mobile'],
    ),
  ]);
  b.fact('fail-ios-background-fetch', 'FAIL-IOS-BACKGROUND-FETCH', ['mobile', 'backend', 'qa'], {
    question: 'Which iOS mechanism for refreshing pinned documents overnight failed?',
    expect: ['background app refresh', 'BGAppRefreshTask'],
  });
  x.tick('off-mobile', 'off-sec', 'off-req');
  x.qa({
    from: 'qa', ws: 'off-tests', to: 'backend', toWs: 'off-sync',
    reply: 'Writing the long-absence cases.',
    q: 'how can a test make the server believe a device has been away for 35 days without waiting 35 days?',
    a: 'Staging has a per-document test clock: POST /internal/docs/{id}/test-clock with days: 35 expires the kept updates as if a month had passed, so the next reconnect from that device gets SNAPSHOT_REQUIRED and the full snapshot. Refresh tokens follow the same clock for the test account.',
  });
  x.tick('off-tests', 'off-ux', 'off-sync', 'off-req', 'off-web');
  x.dv('off-sec', 'First version of the offline data security review: encryption per platform, the wipe rules, the admin switch and the MDM keys.', 'Encryption at rest, wipe rules, admin switch, MDM keys',
    'Encryption: on mobile pinned documents are stored with SQLCipher and a per-device key in the Keychain (available after first unlock) or the Android Keystore; on the web IndexedDB relies on the disk encryption customers require, and computers marked as shared keep nothing after the tab closes. The service worker never caches API responses, only the app shell.',
    'Wipe and control: sign-out, removal from the workspace, a remote wipe by an admin and 30 days without a successful sync delete pinned documents and keys. Admins can turn offline storage off per workspace, which sets offlineDocs to 0 in the entitlements response; Intune and Jamf can set the same through app config keys. Pins, unpins and wipes are recorded with the security events.',
  );
  x.rev('off-sec', true, 'Approved. The shared-computer rule and the admin switch cover the questions customers asked.');
  x.tick('off-sec', 'off-mobile', 'off-tests', 'off-ux', 'off-sync');
  x.dv('off-mobile', 'First version of the offline apps: encrypted pinned documents, editing without a connection, foreground and push sync, and the sync states.', 'Encrypted SQLite store, offline editing, foreground and push sync',
    'Storage: pinned documents are Yjs snapshots plus local updates in SQLite, encrypted with SQLCipher; documents over 20 MB download on Wi-Fi only unless the user allows mobile data. A pinned document opens in 0.8 s on a Pixel 4a. Copies refresh on every foreground and on the doc.updated silent push; the pinned list shows the age of each copy.',
    'Offline editing: local updates are written to SQLite before they reach the screen, then sent after the state vector exchange in batches of at most 1 MB. Two phones ticking the same checklist offline end with identical ticks. Sign-out and removal wipe every pinned document and the key.',
  );
  x.rev('off-mobile', false, 'Works offline, but the storage screen lets me pin a whole 400-document folder on Team and fills 1.2 GB. The per-device cap is in the stories and in our conventions; the apps have to enforce it.');
  x.tick('off-mobile', 'off-tests', 'off-ux');
  x.dv('off-mobile', 'Enforced the per-device cap in the apps.', 'Pin cap from offlineDocs and 200 MB; folder pins stop at the cap',
    'Cap: the pin action reads offlineDocs from the entitlements response and the 200 MB device cap, shows the size before confirming and refuses a pin past either; a folder pin stops at the cap and says "38 documents were not made available offline". The storage screen shows the total against both caps.',
  );
  x.rev('off-mobile', true, 'Approved. The folder pin message says exactly how many documents were left out.');
  x.tick('off-tests', 'off-req', 'off-sec', 'off-mobile', 'off-ux', 'off-tests');
  x.status('Last week of 3.4. One line each on what is left, please.', ['off-req', 'off-ux', 'off-sync', 'off-web', 'off-mobile', 'off-sec', 'off-tests']);
  x.tick('off-tests', 'off-ux', 'off-mobile', 'off-sec', 'off-web');
  x.dv('off-tests', 'First version of the 3.4 test plan and the first run on the device lab, with story and build on every result.', 'Plan traced to OFF-01..OFF-10; device lab; first run',
    'Plan: OFF-01 to OFF-10 trace to 92 automated cases on four device profiles that cut the network on command; long absences use the server test clock; two-device offline cases compare both documents after reconnect.',
    'First run, OFF-07 / build 3.4.0-rc1: 88 of 92 pass. Failures: OFF-10 / build 3.4.0-rc1, a commenter\'s offline checklist ticks are applied instead of becoming suggestions; OFF-04 / build 3.4.0-rc1, images in pinned documents are missing on the iPhone SE after a restart; two flaky install-prompt waits.',
  );
  x.rev('off-tests', false, 'The plan says nothing about the morning reconnect of whole field teams, which is the load pattern we expect, or about wipes on devices that are offline when someone is removed. Both are in the stories.');
  x.tick('off-tests', 'off-req', 'off-tests');
  x.dv('off-tests', 'Added the morning reconnect test and offline wipe cases; release pass on rc2.', 'Morning reconnect load test; offline wipe cases; release pass on 3.4.0-rc2',
    'New cases: 2,000 devices reconnecting at 9:00 after a night offline (p95 resync 1.9 s, no lost update); removal and remote wipe of an iPhone and an Android phone that were offline at the time, wiped within 4 seconds of reconnecting; a 35-day absence that ends with a sign-in and every edit synced.',
    'Release pass on build 3.4.0-rc2: 98 of 98 automated cases pass, including OFF-10 / build 3.4.0-rc1 and OFF-04 / build 3.4.0-rc1, now fixed. Known issue: OFF-05 / build 3.4.0-rc2, Safari shows its own offline page for the first visit after installing an update.',
  );
  x.rev('off-tests', true, 'Approved for release; the Safari page is cosmetic and documented.');
  x.close('off-');
}

// ===========================================================================
// Cycle 5: export (Quire 3.5)
// ===========================================================================

const EXP_WS = {
  req: { id: 'exp-req', title: 'Export requirements', brief: 'Write the 3.5 requirements for exporting documents as PDF, Markdown and an HTML archive, from the web and mobile apps and through the public API, as stories EXP-nn with acceptance checklists.', owner: 'analyst', dependsOn: [] },
  ux: { id: 'exp-ux', title: 'Export dialog and download UX', brief: 'Design the export dialog, the progress and download states for long exports, the share sheet on mobile and the email for finished exports.', owner: 'design', dependsOn: ['exp-req'] },
  engine: { id: 'exp-engine', title: 'Export engine', brief: 'Build the engine that renders a document snapshot to PDF, Markdown and an HTML archive with images, tables, checklists and comments, as asynchronous export jobs.', owner: 'backend', dependsOn: ['exp-req'] },
  web: { id: 'exp-web', title: 'Web export dialog and downloads', brief: 'Build the export dialog, job progress and downloads in the web app against the export job API.', owner: 'web', dependsOn: ['exp-ux', 'exp-engine'] },
  mobile: { id: 'exp-mobile', title: 'Mobile export and share sheet', brief: 'Let people export a document from the iOS and Android apps and hand the file to the system share sheet.', owner: 'mobile', dependsOn: ['exp-ux', 'exp-engine'] },
  workers: { id: 'exp-workers', title: 'Render workers and export storage', brief: 'Run the render worker pool and the job queue, store finished exports in a private bucket with expiring download links, and size the pool for month-end peaks.', owner: 'ops', dependsOn: ['exp-engine'] },
  tests: { id: 'exp-tests', title: 'Export test plan and release pass', brief: 'Write the 3.5 test plan, compare exports of reference documents format by format, load-test the workers and run the release pass.', owner: 'qa', dependsOn: ['exp-web', 'exp-mobile', 'exp-workers'] },
} satisfies Record<string, Ws>;

const EXP_DOCS: Ws = { id: 'exp-docs', title: 'Export help centre and API guide', brief: 'Write the help centre articles for exporting documents and workspaces, the public API guide for export jobs with examples in curl and Python, and the 3.5 release notes.', owner: 'analyst', dependsOn: ['exp-req'] };

function cycleExport(x: Ctx): void {
  const { b } = x;
  b.human(
    'Quire 3.4 is out: 3,100 devices pinned documents in the first week and the field teams have stopped typing up paper checklists at night. Next is 3.5, export. Customers want their documents out of Quire in proper formats: PDF for clients, Markdown for engineering wikis, an HTML archive for the intranet. Some of them also want it through the API for their own tooling. Six weeks, please.',
  );
  b.replan({
    workstreams: Object.values(EXP_WS),
    contracts: [
      { id: 'c-exp-req-tests', from: 'exp-req', to: 'exp-tests', spec: 'Stories are numbered EXP-nn with acceptance checklists that the test plan traces one to one; every result names the story id and the build number.' },
      { id: 'c-exp-engine-web', from: 'exp-engine', to: 'exp-web', spec: 'Export jobs (CONTRACT-EXPORT-JOBS): POST /v2/exports with {docId, format} and an Idempotency-Key returns 202 and a jobId; GET /v2/exports/{jobId} returns queued, rendering, done or failed, with progress from 0 to 100; a done job has a downloadUrl that expires 24 hours after it was issued and needs no access token. Failures use the {code, message, requestId} body, for example EXPORT_TOO_LARGE.' },
      { id: 'c-exp-engine-mobile', from: 'exp-engine', to: 'exp-mobile', spec: 'The same export job endpoints (CONTRACT-EXPORT-JOBS); the apps poll at most every 2 seconds and stop polling in the background, and the export.done push carries the jobId.' },
      { id: 'c-exp-engine-workers', from: 'exp-engine', to: 'exp-workers', spec: 'The engine runs as a worker image that takes jobs from the export queue, renders from the document\'s Yjs snapshot, writes the file to the exports bucket and reports progress; a job may use at most 2 GB of memory and 5 minutes.' },
      { id: 'c-exp-ux-web', from: 'exp-ux', to: 'exp-web', spec: 'Figma frames for the export dialog, progress, the download toast and the finished-export email, using UI kit names.' },
    ],
  });
  b.fact('contract-export-jobs', 'CONTRACT-EXPORT-JOBS', ['backend', 'web', 'mobile', 'qa', 'ops'], {
    question: 'What does POST /v2/exports return, and how long does the download URL stay valid?',
    expect: ['202', '24 hours'],
  });

  x.tasks('exp-req', [
    'the 212 support requests for exports from the last six months, grouped by format: 61% PDF for clients, 22% Markdown for wikis, 9% HTML for intranets and the rest asking for Word',
    'interviews with four customers who export every week: an agency that sends PDFs to clients, two engineering teams that mirror documents into Git, and a law firm that sends contracts for review',
    'the stories for exporting one document as PDF, Markdown or an HTML archive, from the web, from the phones and through the API',
    'what each format keeps: headings, tables, checklists, images, embeds, comments and suggestions, written as a table per format so QA can check each cell',
    'the PDF page rules: A4 or US Letter by the workspace country, page numbers, the document title in the header and tagged PDF for screen readers',
    'the API stories for customers who run exports from their own tooling, with the job states and the expiring download link',
    'what a viewer, commenter and editor may export, and how outside reviewers are treated',
    'the Word stories after the owner\'s change: comments as Word comments and suggestions as tracked changes',
    'the limits: documents above 500 pages or 1 GB of images return EXPORT_TOO_LARGE with a suggestion to export by section',
    'acceptance checklists for EXP-01 to EXP-10 with sizes and timings written out, for example a 50-page document with 30 images as PDF in under 20 seconds',
    'the rules for exporting from a read_only workspace during a failed payment, which must stay possible so customers can always take their data',
    'a read-through of every story with the law firm\'s knowledge manager, who checked the Word stories against how their partners review drafts',
    'the workspace export stories for admins: every document, attachment and comment in one archive, on Business only',
    'the non-goals: no export to Google Docs, no scheduled exports and no PowerPoint in 3.5',
    'the release notes outline for 3.5',
    'a last consistency pass across the stories and the format table',
  ]);
  x.tasks('exp-ux', [
    'an audit of how people export today: the browser print dialog, which loses comments and splits tables across pages, and copy-paste into Word',
    'the export dialog with the format choice, page size for PDF, and switches for comments and suggestions where the format can carry them',
    'the progress state for exports that take longer than three seconds, which moves to a toast so people can keep working',
    'the download toast and the notification-centre entry for finished exports, with the expiry time of the link',
    'the email for exports that finish after the person has left, with the file name and a link that expires after 24 hours',
    'the error states: EXPORT_TOO_LARGE with the suggestion to export by section, and a failed render with a retry',
    'the mobile export sheet that hands the finished file to the system share sheet',
    'the Word options after the owner\'s change: comments as Word comments, suggestions as tracked changes, or a clean copy',
    'the read_only state, where export stays available and the dialog says why it matters',
    'a usability test with five people who exported a contract for a client and a runbook for a wiki',
    'the workspace export page for admins, with an estimate of the archive size and the time it will take',
    'contrast and focus checks for the dialog, the toast and the email',
    'the PDF cover and header styles, matched to the editor typography',
    'the empty state of the exports list in settings',
    'the redlines for the export dialog and the mobile export sheet',
    'the hand-off notes for QA covering every export state from queued to an expired link',
  ]);
  x.tasks('exp-engine', [
    'a spike rendering three reference documents to PDF with headless Chromium, which gives the best tables and page breaks of the four options we tried',
    'the document model reader that turns a Yjs snapshot into our block tree without loading the live document on a sync server',
    'the Markdown writer for headings, lists, checklists, tables and code blocks, with images exported next to the file and linked relatively',
    'the HTML archive writer with one HTML file per document, the stylesheet and the images in a folder, zipped',
    'rendering PDFs with headless Chromium directly inside the API process, which was the shortest path for the first prototype',
    'the export queue and the job table with queued, rendering, done and failed states and progress from 0 to 100',
    'POST /v2/exports and GET /v2/exports/{jobId} with idempotency keys and the error catalogue codes',
    'the role rules for exports: viewers and commenters may export what they can see, outside reviewers only PDF',
    'reference documents for every block type, rendered to every format and kept as the expected output',
    'the DOCX writer after the owner\'s change, first through pandoc and then on our own',
    'comments as Word comments and suggestions as Word tracked changes with the author and the time',
    'the workspace export job: every document as Markdown plus attachments, comments as JSON and a manifest whose member list comes from the memberships table, never from a cached seat count',
    'the limits check before rendering, which returns EXPORT_TOO_LARGE above 500 pages or 1 GB of images',
    'the export.done event for push notifications and the email',
    'load tests with 500 PDF exports queued in one minute',
    'the final API document for export jobs',
  ]);
  x.tasks('exp-web', [
    'regenerating the API client with the export job endpoints and their error codes',
    'the export dialog with the format choice and the switches for comments and suggestions',
    'starting a job with an Idempotency-Key per click, so a double click creates one export',
    'polling the job every second while the dialog is open and handing over to a toast after three seconds',
    'the download toast and the notification-centre entry with the expiry time of the link',
    'the file names of downloads, which first used the document title as it is',
    'a warning in the dialog when the document has changes on this device that have not synced yet, because the export renders the server snapshot',
    'the Word options in the dialog after the owner\'s change',
    'the workspace export page for admins with the size estimate',
    'export from a read_only workspace, which stays enabled',
    'the exports list in settings with the last 20 exports and their links',
    'Playwright cases for each format with a download check',
    'a pass on keyboard access and screen reader labels in the dialog',
    'the bundle check after adding the dialog',
    'a last visual pass on the export dialog and toast against the redlines',
  ]);
  x.tasks('exp-mobile', [
    'the export action in the document menu, with the formats the phone can offer',
    'starting a job and polling at most every 2 seconds while the app is in the foreground',
    'the export.done push that opens the share sheet with the finished file, instead of counting on background fetch to notice finished exports',
    'downloading the file into the app\'s cache and cleaning the cache after a day',
    'handing the file to the share sheet on iOS and to the Android sharesheet with the right MIME types',
    'exporting a pinned document while offline, which offers only Markdown rendered on the device',
    'the Word export on the phone after the owner\'s change',
    'the error states for EXPORT_TOO_LARGE and failed renders',
    'large-font and small-screen passes for the export sheet',
    'Detox cases for each format and for the share sheet',
    'release builds 3.5.0 for TestFlight and the Play internal track, with the share sheet entries checked on both stores',
    'checking the export sheet in German and French',
    'the final review of the export sheet with design',
  ]);
  x.tasks('exp-workers', [
    'the render worker image with Chromium, fonts for 14 scripts and the engine, built in CI and scanned for vulnerabilities',
    'the worker pool on ECS with autoscaling on the queue depth, from 2 to 40 workers',
    'the exports bucket: private, encrypted, files deleted after 7 days, download links signed for 24 hours',
    'per-workspace limits of 20 concurrent export jobs, so one customer cannot fill the queue',
    'memory and time limits per job of 2 GB and 5 minutes, enforced by the container, with the job marked failed and retried once',
    'month-end capacity: agencies export invoices of work and reports on the last two working days, about six times the normal volume',
    'dashboards for queue depth, render time per format and failure rate',
    'alerts when the oldest queued job is older than 2 minutes',
    'the cost estimate for the pool, about USD 1,400 a month at normal volume',
    'the separate queue and larger workers for workspace exports',
    'a game day that kills workers in the middle of renders',
    'the runbook for a stuck queue',
    'the render pool sign-off for 3.5',
    'the render pool hand-over notes for the on-call rotation',
  ]);
  x.tasks('exp-tests', [
    'tracing EXP-01 to EXP-12 to test cases',
    'the reference document set: 40 documents with every block type, long tables, right-to-left text and 14 scripts',
    'format checks for PDF: page breaks, tagged structure, fonts embedded and page size by country',
    'format checks for Markdown and the HTML archive, opened in GitHub, GitLab and Confluence',
    'Word checks in Microsoft Word and LibreOffice for comments and tracked changes',
    'API cases for the job states, idempotency and expired download links',
    'role cases for viewers, commenters, editors and outside reviewers',
    'workspace export cases for admins on Business and refusals on Team',
    'limit cases at 500 pages and 1 GB of images',
    'read_only export cases during a failed payment',
    'the month-end load test with 3,000 exports in an hour',
    'the regression run on offline, co-editing and billing',
    'the release pass on build 3.5.0-rc2',
    'the known-issues list for 3.5, with the formats each item affects',
    'the 3.5 sign-off notes, with the month-end load numbers',
  ]);

  x.start('exp-req', 'Starting the 3.5 export requirements with the 212 export requests from support.', 'exp-req: PDF/Markdown/HTML; API jobs; per-format table; limits; stories EXP-nn.');
  x.start('exp-engine', 'Starting the export engine with a spike on PDF renderers, using three of our hardest reference documents.', 'exp-engine: Chromium spike; Yjs snapshot reader; Markdown and HTML writers; job queue; API.', 'c-exp-engine-web');
  x.start('exp-workers', 'Starting the render workers: the image first, so the engine has somewhere to run.', 'exp-workers: Chromium + fonts image; ECS pool 2..40 on queue depth; private bucket; 24 h signed links.', 'c-exp-engine-workers');
  x.tick('exp-req', 'exp-engine', 'exp-workers');
  x.qa({
    from: 'analyst', ws: 'exp-req', to: 'backend', toWs: 'exp-engine',
    reply: 'Writing the per-format table.',
    q: 'can comments and suggestions survive in Markdown at all, or should the table say that Markdown drops them?',
    a: 'Markdown has no standard for either. The table should say Markdown drops suggestions and writes resolved and open comments as footnotes only when the person asks for them; the HTML archive keeps both as side notes, and PDF prints open comments in the margin.',
  });
  x.tick('exp-req', 'exp-engine', 'exp-workers');
  x.start('exp-ux', 'Starting the export dialog by watching how people export today.', 'exp-ux: print dialog loses comments; dialog with format + switches; progress to toast after 3 s; email for late exports.', 'exp-req');
  x.tick('exp-ux', 'exp-req', 'exp-engine');
  x.dv('exp-req', 'First version of the 3.5 export requirements: three formats from every client and the API, with a per-format table of what each keeps.', 'Formats, per-format table, API jobs; EXP-01 to EXP-06',
    'Formats: PDF for sending to clients (A4 or US Letter by workspace country, page numbers, title in the header, tagged for screen readers), Markdown for wikis and Git (images next to the file, linked relatively) and an HTML archive for intranets. EXP-01 to EXP-03 export one document in each format from the web; EXP-04 from the phones; EXP-05 through the API.',
    'What each format keeps: headings, lists, checklists, tables and images everywhere; PDF prints open comments in the margin; the HTML archive keeps comments and suggestions as side notes; Markdown drops suggestions and writes comments as footnotes on request. EXP-06 documents above 500 pages or 1 GB of images return EXPORT_TOO_LARGE with a suggestion to export by section.',
  );
  x.rev('exp-req', false, 'Clear formats, but nothing says who may export what. Can an outside reviewer with the commenter role export the whole contract as Markdown and paste it anywhere? Tie exports to the document roles from 3.3, and keep export open in read_only, because customers must always be able to take their data.');
  x.tick('exp-req', 'exp-ux');
  x.dv('exp-req', 'Added the export rules per document role and the read_only rule.', 'Exports by document role; export allowed in read_only',
    'Roles: editors, commenters and viewers may export what they can open, in every format; outside reviewers may export PDF only, with a footer naming them and the date. Export stays available in a read_only workspace during a failed payment, and in every plan, because customers must always be able to take their data out. EXP-07 an admin can turn exports off for outside reviewers.',
  );
  x.rev('exp-req', true, 'Approved as the 3.5 baseline.');
  x.start('exp-web', 'Starting the web export dialog against the export job contract.', 'exp-web: regenerate client; dialog; Idempotency-Key per click; poll 1 s then toast; downloads.', 'c-exp-engine-web');
  x.start('exp-mobile', 'Starting export in the apps, ending in the system share sheet.', 'exp-mobile: export menu; poll 2 s in foreground; export.done push; share sheet; offline Markdown on device.', 'c-exp-engine-mobile');
  x.start('exp-tests', 'Starting the 3.5 test plan with a reference document set.', 'exp-tests: 40 reference docs; per-format checks; API cases; role cases; month-end load.', 'c-exp-req-tests');
  x.tick('exp-engine', 'exp-workers', 'exp-web', 'exp-mobile', 'exp-tests', 'exp-ux');
  b.work('backend', 'exp-engine', 'Recording a failed approach (FAIL-PDF-IN-API): the first prototype rendered PDFs with headless Chromium inside the API process. A 120-page document with images took 1.6 GB of memory, the container was killed and took 300 open requests with it, and two parallel exports were enough to slow every API call. Rendering now runs only in the render workers behind the export queue.', [
    op.failure(
      'Rendering PDF exports with headless Chromium inside the API process (FAIL-PDF-IN-API).',
      'One large document used 1.6 GB and got the API container killed with 300 requests in flight, and parallel renders slowed every API call; rendering belongs in separate workers behind a queue.',
      ['exp-engine'],
    ),
  ]);
  b.fact('fail-pdf-in-api', 'FAIL-PDF-IN-API', ['backend', 'ops', 'qa'], {
    question: 'Where was PDF rendering first done, which failed?',
    expect: ['headless Chromium', 'API process'],
  });
  x.tick('exp-engine', 'exp-workers', 'exp-ux', 'exp-web');
  x.qa({
    from: 'web', ws: 'exp-web', to: 'backend', toWs: 'exp-engine',
    reply: 'Building the warning for unsynced changes in the export dialog.',
    q: 'does the export render the server snapshot or what my browser has? If someone exports right after editing offline, are their last changes in the file?',
    a: 'The server snapshot, always: the workers never see the browser. So if the document shows "Waiting to sync", the dialog should say the export will not include those changes and offer to wait until they are synced. Once the sync state is Synced, the next export includes everything.',
  });
  x.record({ id: 'c-exp-snapshot-web', from: 'exp-engine', to: 'exp-web', spec: 'Exports always render the server snapshot of a document. While the document shows "Waiting to sync", the export dialog says the export will not include those changes and offers to start it once they are synced.' });
  x.tick('exp-web', 'exp-mobile', 'exp-tests', 'exp-req');

  // Change 1: Word instead of the HTML archive
  b.human(
    'Change of plan for 3.5 (CHANGE-DOCX-EXPORT): the law firms and two of our agency customers say the most important format is Word, not an HTML archive. Their clients review contracts in Word, so comments must arrive as Word comments and suggestions as tracked changes. We drop the HTML archive from 3.5 and add DOCX export instead. Nobody has asked for HTML since the interviews.',
  );
  b.fact('change-docx-export', 'CHANGE-DOCX-EXPORT', ['*'], {
    question: 'Which document format is the most important export format in 3.5? Give only the current value.',
    expect: ['DOCX', 'Word'],
  });
  b.replan({
    workstreams: b.currentPlan.workstreams.map(w =>
      w.id === 'exp-req'
        ? { ...w, brief: 'Write the 3.5 requirements for exporting documents as PDF, Markdown and DOCX (comments as Word comments, suggestions as tracked changes), from the web and mobile apps and through the public API, as stories EXP-nn with acceptance checklists.' }
        : w.id === 'exp-engine'
          ? { ...w, brief: 'Build the engine that renders a document snapshot to PDF, Markdown and DOCX with images, tables, checklists, comments as Word comments and suggestions as tracked changes, as asynchronous export jobs.' }
          : w.id === 'exp-ux'
            ? { ...w, brief: 'Design the export dialog with the Word options, the progress and download states for long exports, the share sheet on mobile and the email for finished exports.' }
            : w,
    ),
    contracts: b.currentPlan.contracts,
  });
  x.dv('exp-req', 'Replaced the HTML archive with DOCX in the stories and the per-format table, after the owner\'s change.', 'DOCX instead of the HTML archive; EXP-08 and EXP-09',
    'Word: EXP-08 export a document as DOCX where open comments become Word comments with author and time, and suggestions become tracked changes the recipient can accept or reject in Word; EXP-09 export a clean copy without comments or suggestions. The HTML archive is removed from 3.5; the per-format table now has PDF, Markdown and DOCX columns.',
  );
  x.rev('exp-req', true, 'Approved; it follows the owner\'s change.');
  x.tick('exp-ux', 'exp-engine', 'exp-workers', 'exp-web', 'exp-mobile');
  x.dv('exp-ux', 'First version of the export dialog, progress and download designs, with the Word options and the unsynced-changes warning.', 'Export dialog, progress toast, download and email, Word options',
    'Dialog: format (PDF, Word, Markdown), page size for PDF, and for Word a choice between comments and tracked changes or a clean copy. If the document is waiting to sync, a note says the export will not include those changes and offers "Export when synced". After three seconds the dialog closes into a progress toast so people can keep working.',
    'Finished exports: a download toast with the file name and "Link valid for 24 hours", an entry in the notification centre, and an email when the person has left the page. EXPORT_TOO_LARGE shows the limits and a link to export by section; a failed render offers one retry.',
  );
  x.rev('exp-ux', true, 'Approved. Handing over to a toast after three seconds keeps people working.');
  x.tick('exp-ux', 'exp-mobile', 'exp-tests', 'exp-req');
  x.dv('exp-engine', 'First version of the export engine: snapshot reader, PDF in the workers, Markdown, the job API and the role rules. DOCX is next.', 'Snapshot reader, PDF and Markdown writers, export jobs',
    'Rendering: a reader turns the document\'s Yjs snapshot into our block tree, so exports never load the live document on a sync server. PDF is rendered by headless Chromium in the render workers; Markdown writes images next to the file and links them relatively. A 50-page document with 30 images renders to PDF in 11 seconds.',
    'Jobs: POST /v2/exports takes an Idempotency-Key and returns 202 with a jobId; GET /v2/exports/{jobId} reports queued, rendering, done or failed with progress. Viewers, commenters and editors may export; outside reviewers only PDF with a footer naming them.',
  );
  x.rev('exp-engine', false, 'The outputs look good today, but nothing stops them from changing silently: I changed the table CSS in a branch and three exports broke without a single failing test. Every format needs expected outputs that a change has to match or update on purpose.', [
    'Every export format has golden files for the 40 reference documents; CI renders them on every change and fails on any difference, and an intended change updates the golden file in the same pull request with the visual diff attached (CONV-GOLDEN-FILES).',
  ]);
  b.fact('conv-golden-files', 'CONV-GOLDEN-FILES', ['backend', 'qa', 'ops'], {
    question: 'What must CI compare every export format against?',
    expect: ['golden files'],
  });
  x.tick('exp-engine', 'exp-web', 'exp-workers', 'exp-req');
  x.status('Two weeks into 3.5. Status from each of you, please, and say whether the Word work moved your dates.', ['exp-req', 'exp-ux', 'exp-engine', 'exp-web', 'exp-mobile', 'exp-workers', 'exp-tests']);
  x.tick('exp-engine', 'exp-mobile', 'exp-tests');
  b.work('backend', 'exp-engine', 'Recording a failed approach (FAIL-PANDOC-DOCX): I first produced DOCX by converting our HTML through pandoc. It dropped every comment, turned suggestions into plain text with both versions, and lost the column widths of tables, so the law firm\'s test contract came out unusable. I am writing DOCX directly with the docx library, which supports comments and tracked changes.', [
    op.failure(
      'Producing DOCX by converting the exported HTML with pandoc (FAIL-PANDOC-DOCX).',
      'The conversion dropped all comments, flattened suggestions into plain text and lost table column widths; writing the DOCX directly gives Word comments and tracked changes.',
      ['exp-engine'],
    ),
  ]);
  b.fact('fail-pandoc-docx', 'FAIL-PANDOC-DOCX', ['backend', 'qa'], {
    question: 'Which tool was first used to produce DOCX files, and failed?',
    expect: ['pandoc'],
  });
  x.tick('exp-engine', 'exp-ux', 'exp-req', 'exp-web');
  x.qa({
    from: 'mobile', ws: 'exp-mobile', to: 'backend', toWs: 'exp-engine',
    reply: 'Deciding what the apps can export offline.',
    q: 'can the engine\'s Markdown writer run on the phone, so a pinned document can be exported without a connection?',
    a: 'The Markdown writer is plain TypeScript with no server dependencies; I have published it as the @quire/export-markdown package. It reads the same Yjs document the app already has for pinned documents. PDF and DOCX need the workers, so offline export is Markdown only.',
  });
  x.record({ id: 'c-exp-markdown-mobile', from: 'exp-engine', to: 'exp-mobile', spec: 'The Markdown writer ships as the @quire/export-markdown package with the same output as the workers; the apps run it on the Yjs document of a pinned document to export Markdown without a connection. PDF and DOCX need the workers.' });
  x.tick('exp-mobile', 'exp-workers', 'exp-tests');
  x.dv('exp-engine', 'Added golden files for every format and the DOCX writer with Word comments and tracked changes.', 'Golden files in CI; DOCX with comments and tracked changes',
    'Golden files: the 40 reference documents are rendered to PDF, Markdown and DOCX in CI on every change and compared with the stored golden file; a difference fails the build unless the pull request updates the golden file with a visual diff. DOCX is written directly with the docx library: open comments become Word comments with author and time, suggestions become tracked changes, and table column widths are kept.',
  );
  x.rev('exp-engine', true, 'Approved. The law firm\'s test contract opens cleanly in Word.');
  x.tick('exp-web', 'exp-workers', 'exp-ux', 'exp-req', 'exp-mobile');

  // Change 2: whole-workspace export for admins
  b.human(
    'One more change for 3.5 (CHANGE-WORKSPACE-EXPORT): two enterprise customers have it in their contract renewals that an admin must be able to export the whole workspace at any time: every document, attachment and comment, for their own archive. Please add a workspace export for admins, on the Business plan only, to this release.',
  );
  b.fact('change-workspace-export', 'CHANGE-WORKSPACE-EXPORT', ['backend', 'web', 'analyst', 'qa', 'ops'], {
    question: 'Which plan gets the whole-workspace export for admins? Give only the current value.',
    expect: ['Business'],
  });
  b.replan({
    workstreams: [
      ...b.currentPlan.workstreams.map(w =>
        w.id === 'exp-engine'
          ? { ...w, brief: 'Build the engine that renders a document snapshot to PDF, Markdown and DOCX with comments and tracked changes, and the workspace export job that archives every document, attachment and comment for admins, as asynchronous export jobs.' }
          : w.id === 'exp-web'
            ? { ...w, brief: 'Build the export dialog, job progress, downloads and the admin workspace export page in the web app against the export job API.' }
            : w,
      ),
      EXP_DOCS,
    ],
    contracts: [
      ...b.currentPlan.contracts,
      { id: 'c-exp-workspace-web', from: 'exp-engine', to: 'exp-web', spec: 'POST /v2/workspaces/{id}/exports starts a workspace export for admins only (403 FORBIDDEN_ROLE otherwise) and only when the entitlements response lists workspaceExport (Business); the job reports progress like a document export and the archive holds every document as Markdown and DOCX, attachments, comments as JSON and a manifest.' },
      { id: 'c-exp-docs-tests', from: 'exp-docs', to: 'exp-tests', spec: 'Every help centre article and API guide section lists the story ids it covers, so QA can check it against the release build.' },
    ],
  });
  x.tasks('exp-docs', [
    'the help centre outline: exporting a document, the formats and what each keeps, exporting from the phone, and workspace exports for admins',
    'the article on Word exports with comments and tracked changes, with screenshots from Word and LibreOffice',
    'the API guide for export jobs with curl and Python examples, including polling, the expiring link and the error codes',
    'the article on workspace exports, the archive layout and how long a large workspace takes',
    'the German and French translations of the articles',
    'the 3.5 release notes draft',
    'a check of every export article and API example against build 3.5.0-rc2 with QA',
    'the final copy edit of the API guide',
  ]);
  x.start('exp-docs', 'Starting the export help centre and the API guide.', 'exp-docs: articles per story; API guide with curl + Python; workspace export article; DE and FR; release notes.', 'c-exp-docs-tests');
  x.dv('exp-req', 'Added the workspace export stories for admins on Business.', 'Workspace export EXP-10 to EXP-12',
    'Workspace export: EXP-10 an admin of a Business workspace exports every document (as Markdown and DOCX), every attachment and every comment as one archive with a manifest; EXP-11 the admin gets an email with a link valid for 24 hours when it is done, and every workspace export is recorded in the security events; EXP-12 owners and admins of Team workspaces see the feature with an upgrade note, members never see it.',
  );
  x.rev('exp-req', true, 'Approved. Members never seeing workspace export keeps the page honest.');
  x.tick('exp-docs', 'exp-engine', 'exp-mobile', 'exp-tests');
  x.qa({
    from: 'web', ws: 'exp-web', to: 'analyst', toWs: 'exp-req',
    reply: 'Building the admin workspace export page.',
    q: 'should a Team admin see the workspace export page with an upgrade note, or should it be hidden entirely?',
    a: 'Show it to owners and admins with the upgrade note when the entitlements response does not list workspaceExport; hide it from members. The server-side role check and the entitlement check decide, the page only mirrors them, as in EXP-12.',
  });
  x.tick('exp-web', 'exp-workers', 'exp-docs', 'exp-ux');
  x.dv('exp-web', 'First version of the web export dialog and downloads, with the Word options and the unsynced-changes warning.', 'Export dialog, job polling, downloads, exports list',
    'Dialog: PDF, Word and Markdown, page size for PDF, and comments and tracked changes or a clean copy for Word. Each click sends its own Idempotency-Key, so a double click creates one job; the dialog polls every second and hands over to a toast after three seconds. A document waiting to sync shows the note and "Export when synced".',
    'Downloads: the toast and the notification centre link to the file with "Link valid for 24 hours"; the exports list in settings keeps the last 20 exports. Files are named after the document title as typed, for example "Q3 Plan: Draft #2 / Final?.pdf".',
  );
  x.rev('exp-web', false, 'The file names break things: slashes and colons in titles produce files Windows will not save, and two exports of the same document on different days get the same name. Fix the naming everywhere we produce files, not only on the web.', [
    'Exported files are named with one file name pattern on every platform and in the API: <title as an ASCII-safe slug>-<YYYY-MM-DD in UTC>.<ext>, at most 80 characters before the date, for example q3-plan-draft-2-final-2027-03-04.pdf (CONV-EXPORT-FILENAMES).',
  ]);
  b.fact('conv-export-filenames', 'CONV-EXPORT-FILENAMES', ['backend', 'web', 'mobile', 'qa'], {
    question: 'What file name pattern must exported files follow?',
    expect: ['slug'],
  });
  x.tick('exp-web', 'exp-mobile', 'exp-engine', 'exp-web');
  x.dv('exp-web', 'Moved file naming to the shared pattern and added the admin workspace export page.', 'ASCII-safe dated file names; workspace export page',
    'File names: downloads use the file name pattern the engine now sets in Content-Disposition, an ASCII-safe slug of the title plus the UTC date, so Windows saves every file and exports from different days differ. Workspace export page for owners and admins: the size estimate, the start button, progress, and for Team workspaces an upgrade note; members never see it.',
  );
  x.rev('exp-web', true, 'Approved. Dated ASCII-safe names fix Windows and the same-name problem at once.');
  x.tick('exp-web', 'exp-ux', 'exp-tests', 'exp-req');
  x.qa({
    from: 'ops', ws: 'exp-workers', to: 'backend', toWs: 'exp-engine',
    reply: 'Sizing the queue for workspace exports.',
    q: 'how big and how long is a workspace export of our largest Business customer, so I can decide whether it shares the queue with document exports?',
    a: 'The largest workspace has 48,000 documents and 31 GB of attachments: about 2 hours on one worker and a 34 GB archive. It must not share the queue; give workspace exports their own queue and workers with 8 GB of memory and no 5-minute limit.',
  });
  x.record({ id: 'c-exp-workspace-queue', from: 'exp-engine', to: 'exp-workers', spec: 'Workspace exports run on their own queue and workers with 8 GB of memory and no 5-minute limit, so they never delay document exports; a workspace export of 48,000 documents takes about 2 hours.' });
  x.tick('exp-workers', 'exp-docs', 'exp-mobile');
  x.status('Week four of 3.5. Status from each of you, please.', ['exp-req', 'exp-ux', 'exp-engine', 'exp-web', 'exp-mobile', 'exp-workers', 'exp-tests', 'exp-docs']);
  x.tick('exp-engine', 'exp-ux', 'exp-req', 'exp-web');
  x.dv('exp-engine', 'Added the workspace export job and moved file naming into the engine.', 'Workspace export job; file name pattern in Content-Disposition',
    'Workspace export: POST /v2/workspaces/{id}/exports checks the admin role on the server and workspaceExport in the entitlements, then queues one job on the separate workspace queue; the archive holds every document as Markdown and DOCX, attachments, comments as JSON and a manifest with ids, authors and ISO 8601 UTC times. The engine sets every file name from the shared pattern.',
  );
  x.rev('exp-engine', true, 'Approved. A separate queue keeps workspace exports from delaying anyone else.');
  x.tick('exp-engine', 'exp-workers', 'exp-tests');
  x.dv('exp-workers', 'First version of the render workers and export storage.', 'Worker pool on ECS, two queues, private bucket with 24-hour links',
    'Workers: the render image has Chromium, fonts for 14 scripts and the engine, rebuilt and scanned in CI. Document exports run on 2 to 40 workers scaled on queue depth, with 2 GB and 5 minutes per job; workspace exports have their own queue and workers with 8 GB and no time limit. Each workspace may run 20 jobs at once.',
    'Storage: finished files go to a private, encrypted bucket and are deleted after 7 days; download links are signed for 24 hours and carry no access token. Alerts fire when the oldest queued job is older than 2 minutes. At normal volume the pool costs about USD 1,400 a month.',
  );
  x.rev('exp-workers', false, 'The pool handles a normal day, but the month-end numbers are missing: agencies export six times the normal volume on the last two working days, and the 40-worker ceiling has never been tested against that.', [
    'Every capacity plan is tested against the known peak (month end for exports, the 9:00 reconnects for offline devices) before review, not only against an average day.',
  ]);
  x.tick('exp-workers', 'exp-tests', 'exp-docs');
  x.dv('exp-workers', 'Tested the month-end peak and raised the ceiling.', 'Month-end peak: 3,000 exports an hour; ceiling 60 workers',
    'Month end: a load test of 3,000 document exports in an hour (six times a normal hour) peaked at 52 workers with the oldest queued job 70 seconds old; the ceiling is raised to 60 and scale-out starts at a queue depth of 20 instead of 50. Killing a third of the workers mid-render failed no job; each was retried once on another worker.',
  );
  x.rev('exp-workers', true, 'Approved. The month-end test answers the capacity question.');
  x.tick('exp-mobile', 'exp-ux', 'exp-docs', 'exp-web', 'exp-engine');
  x.dv('exp-mobile', 'First version of export in the apps: PDF, Word and Markdown through the workers, Markdown on the device offline, and the share sheet.', 'Export from the apps, share sheet, offline Markdown',
    'Export: the document menu offers PDF, Word and Markdown; the app polls the job at most every 2 seconds in the foreground and the export.done push opens the share sheet with the file. Files are cached for a day and named with the shared file name pattern.',
    'Offline: a pinned document can be exported as Markdown without a connection through the same Markdown writer the engine uses, running on the device; PDF and Word say "Needs a connection". EXPORT_TOO_LARGE and failed renders show the same messages as the web.',
  );
  x.rev('exp-mobile', true, 'Approved. Offline Markdown through the same writer keeps the output identical.');
  x.tick('exp-tests', 'exp-docs', 'exp-ux');
  x.dv('exp-docs', 'First version of the export help centre and the API guide.', 'Help centre articles, API guide for export jobs, 3.5 release notes',
    'Articles (each lists its stories): exporting a document and what each format keeps (EXP-01 to EXP-03, EXP-06), Word exports with comments and tracked changes (EXP-08, EXP-09), exporting from the phone and offline Markdown (EXP-04), and workspace exports for admins (EXP-10 to EXP-12). German and French follow the agency glossary.',
    'API guide: starting a job, polling, the 24-hour download link and the error codes, with curl and Python examples that send an Idempotency-Key. Release notes lead with Word export and workspace export, and say the HTML archive did not make 3.5.',
  );
  x.rev('exp-docs', true, 'Approved. The API guide examples ran unchanged against staging.');
  x.tick('exp-tests', 'exp-req', 'exp-ux', 'exp-mobile', 'exp-docs');
  x.status('Last week of 3.5. One line each on what is left, please.', ['exp-req', 'exp-ux', 'exp-engine', 'exp-web', 'exp-mobile', 'exp-workers', 'exp-tests', 'exp-docs']);
  x.tick('exp-tests', 'exp-req', 'exp-tests', 'exp-web', 'exp-workers');
  x.dv('exp-tests', 'First version of the 3.5 test plan and the first run on the reference set.', 'Plan traced to EXP-01..EXP-12; reference set; first run',
    'Plan: EXP-01 to EXP-12 trace to 104 automated cases; the 40 reference documents are exported in every format and opened in Word, LibreOffice, GitHub, GitLab and Confluence; API cases cover idempotency, the job states and expired links.',
    'First run, EXP-08 / build 3.5.0-rc1: 99 of 104 pass. Failures: EXP-08 / build 3.5.0-rc1, tracked changes inside table cells open as plain text in LibreOffice; EXP-10 / build 3.5.0-rc1, comments on deleted text are missing from the workspace archive; three flaky download waits.',
  );
  x.rev('exp-tests', false, 'Missing: role cases for outside reviewers, who may only export PDF, and the read_only case, where export must keep working. Both are in the stories and both are things customers will try on day one.');
  x.tick('exp-tests', 'exp-req', 'exp-ux', 'exp-engine', 'exp-req');
  x.dv('exp-tests', 'Added the role and read_only cases; release pass on rc2.', 'Role and read_only cases; release pass on 3.5.0-rc2',
    'New cases: an outside reviewer exports PDF with the footer and is refused Word and Markdown; a viewer exports every format; a workspace in read_only during a failed payment exports every format; a Team admin is refused the workspace export with the upgrade note. Month-end load: 3,000 exports in an hour, none failed.',
    'Release pass on build 3.5.0-rc2: 112 of 112 automated cases pass, including EXP-08 / build 3.5.0-rc1 and EXP-10 / build 3.5.0-rc1, now fixed. Known issue: EXP-02 / build 3.5.0-rc2, Markdown footnotes for comments are numbered per section in GitLab.',
  );
  x.rev('exp-tests', true, 'Approved for release; the GitLab footnotes go into the first patch.');
  x.close('exp-');
}

// ===========================================================================
// Cycle 6: compliance (Quire 3.6)
// ===========================================================================

const COMP_WS = {
  req: { id: 'comp-req', title: 'Compliance requirements', brief: 'Write the 3.6 requirements for the audit log, admin security policies and SOC 2 Type I readiness, as stories CMP-nn with acceptance checklists.', owner: 'analyst', dependsOn: [] },
  ux: { id: 'comp-ux', title: 'Admin console and audit log UX', brief: 'Design the admin console: the audit log viewer with filters, session and sign-in policies, data retention settings and the security overview, for owners and admins.', owner: 'design', dependsOn: ['comp-req'] },
  audit: { id: 'comp-audit', title: 'Audit log service', brief: 'Build the audit log: an append-only store of security and admin events from every service, the admin API to read and export it, retention and streaming to customer SIEMs.', owner: 'backend', dependsOn: ['comp-req'] },
  admin: { id: 'comp-admin', title: 'Web admin console', brief: 'Build the admin console in the web app: audit log viewer, session and sign-in policies, retention settings and the security overview.', owner: 'web', dependsOn: ['comp-ux', 'comp-audit'] },
  mobile: { id: 'comp-mobile', title: 'Mobile admin policies and managed devices', brief: 'Apply the workspace session and sign-in policies in the iOS and Android apps and support managed app configuration from Intune and Jamf.', owner: 'mobile', dependsOn: ['comp-audit'] },
  infra: { id: 'comp-infra', title: 'Infrastructure controls', brief: 'Put the infrastructure controls an auditor will test in place: production access, logging, backups and restores, vulnerability management and change management.', owner: 'ops', dependsOn: ['comp-req'] },
  soc2: { id: 'comp-soc2', title: 'SOC 2 policies and evidence', brief: 'Write the security policies, map Quire\'s controls to the SOC 2 trust services criteria and prepare the evidence for a Type I report.', owner: 'analyst', dependsOn: ['comp-req'] },
  tests: { id: 'comp-tests', title: 'Compliance test plan and release pass', brief: 'Write the 3.6 test plan, check that every service emits its audit events, test the admin policies on every platform and run the release pass.', owner: 'qa', dependsOn: ['comp-admin', 'comp-mobile', 'comp-audit'] },
} satisfies Record<string, Ws>;

const COMP_RESIDENCY: Ws = { id: 'comp-residency', title: 'EU data residency', brief: 'Store every EU workspace in eu-central-1 (Frankfurt): documents, sync servers, attachments, search, exports, backups and logs, and move the existing EU workspaces there without downtime.', owner: 'ops', dependsOn: ['comp-infra'] };

function cycleCompliance(x: Ctx): void {
  const { b } = x;
  b.human(
    'Quire 3.5 is out: Word export is used by a third of our Business workspaces already. The last release of the year is 3.6, compliance. Enterprise security questionnaires keep asking for three things we do not have: an audit log, admin security policies and a SOC 2 report. For 3.6 I want the audit log, the admin console and everything ready for a SOC 2 Type I audit. Six weeks, same team.',
  );
  b.replan({
    workstreams: Object.values(COMP_WS),
    contracts: [
      { id: 'c-comp-req-tests', from: 'comp-req', to: 'comp-tests', spec: 'Stories are numbered CMP-nn with acceptance checklists that the test plan traces one to one; every result names the story id and the build number.' },
      { id: 'c-comp-audit-admin', from: 'comp-audit', to: 'comp-admin', spec: 'Audit events (CONTRACT-AUDIT-EVENTS) have the fields {id, at, workspaceId, actor {type, id, email}, action, target {type, id}, ip, userAgent, details}; at is ISO 8601 in UTC and action is a dotted name such as member.role_changed. The store is append-only and keeps events for 400 days. GET /v2/workspaces/{id}/audit-events is for owners and admins only, with filters on action, actor and time and cursor paging.' },
      { id: 'c-comp-audit-mobile', from: 'comp-audit', to: 'comp-mobile', spec: 'The apps send no audit events themselves; the services record sign-ins, sign-outs and remote wipes. The apps read the workspace policies from GET /v2/workspaces/{id}/policies on launch and on the policies.changed push.' },
      { id: 'c-comp-infra-soc2', from: 'comp-infra', to: 'comp-soc2', spec: 'Every infrastructure control produces evidence on a schedule into the evidence bucket, named <control id>/<YYYY-MM-DD>/<file>, so the auditor sample can be pulled without asking an engineer.' },
      { id: 'c-comp-ux-admin', from: 'comp-ux', to: 'comp-admin', spec: 'Figma frames for the admin console and the audit log viewer, using UI kit names; every table works with the keyboard alone.' },
    ],
  });
  b.fact('contract-audit-events', 'CONTRACT-AUDIT-EVENTS', ['backend', 'web', 'mobile', 'qa', 'ops', 'analyst'], {
    question: 'How long are audit events kept?',
    expect: ['400 days'],
  });

  x.tasks('comp-req', [
    'the last 30 enterprise security questionnaires, of which 27 asked for an audit log, 22 for session policies and 19 for a SOC 2 report, and 11 for data residency in the EU',
    'the list of events customers expect in an audit log, taken from the questionnaires and from what Okta, Slack and Notion record',
    'the audit log stories: an admin searches events by person, action and time, exports them, and streams them to their SIEM',
    'the admin policy stories: session length, idle timeout, two-factor for everyone, SAML enforcement and allowed email domains',
    'the retention stories: how long documents in the trash, deleted members\' data and audit events are kept, and what an admin can change',
    'the stories for the security overview page that answers the questions in a questionnaire at a glance',
    'acceptance checklists for CMP-01 to CMP-08 with every event and setting written out',
    'the stories after the owner\'s Type II change, where every control must run continuously and leave evidence',
    'the residency stories after the owner\'s change: where EU workspace data lives and how an admin can see it',
    'a read-through of every story with the security lead of our largest customer, who added the case of an admin who removes their own audit log access',
    'the rules for which audit events members can see about themselves',
    'the non-goals: no customer-managed encryption keys and no US government regions in 3.6',
    'the release notes outline for 3.6',
    'a last consistency pass across the stories, the event list and the policies',
    'the security questionnaire answer set for sales, updated for 3.6',
  ]);
  x.tasks('comp-ux', [
    'an audit of the admin settings scattered over six pages today, mapped to what each questionnaire asks for',
    'the admin console navigation: overview, members, security policies, audit log, data and retention, billing',
    'the audit log viewer: a dense table with time, person, action and target, filters on each, and a side panel with the full event',
    'the session policy page with session length, idle timeout and sign-out everywhere, with the effect of each choice spelled out',
    'the sign-in policy page: two-factor for everyone, SAML enforcement, allowed email domains and the break-glass owner',
    'the retention settings with the minimums the plan allows and a confirmation that names what will be deleted',
    'the security overview page with the status of each control a questionnaire asks about',
    'the residency badge on the overview and in workspace settings after the owner\'s change',
    'the audit export dialog with the time range and format',
    'a usability test with four IT admins who answered a mock questionnaire using only the console',
    'contrast and keyboard checks of the audit table, which has twelve columns at full width',
    'the mobile policy messages: session ended by policy and device not managed',
    'the empty states of the audit log and the overview for new workspaces',
    'the redlines for the console and the mobile policy messages',
    'the hand-off notes for QA covering every admin policy state',
  ]);
  x.tasks('comp-audit', [
    'the audit event schema, the action names for 64 actions across identity, billing, documents, sharing, exports and offline devices, and the details per action',
    'the append-only audit store in Postgres with an insert-only role, a hash chain over each workspace\'s events and monthly partitions',
    'emitting events from the identity service: sign-ins, failed sign-ins, two-factor changes, SAML configuration, role changes and session revocations',
    'emitting events from billing, sharing, exports, offline wipes and the document role changes through one client library every service uses, with seat changes recorded when they happen, as billing charges them since the nightly proration job was dropped',
    'GET /v2/workspaces/{id}/audit-events with filters on action, actor and time and cursor paging, behind the server-side role check for owners and admins',
    'the audit export as JSON lines through the export job queue, with the same file name pattern as document exports',
    'the policies endpoint GET /v2/workspaces/{id}/policies and the policies.changed push',
    'enforcing session length and idle timeout in the identity service by refusing refresh tokens older than the policy allows',
    'the SIEM stream: signed webhooks with batches of events every 30 seconds for Splunk, Datadog and Sentinel',
    'retention: deleting audit events after 400 days, or after the longer period an Enterprise admin sets',
    'verifying the hash chain nightly and alerting on a break',
    'moving the audit store of EU workspaces to Frankfurt with the rest of their data',
    'load tests with 3,000 events per second during a morning sign-in peak',
    'the runbook for a broken hash chain',
    'the final API document for audit events and policies',
  ]);
  x.tasks('comp-admin', [
    'regenerating the API client with the audit and policy endpoints',
    'the admin console shell and navigation, visible to owners and admins only',
    'the audit log viewer table with server-side filters and cursor paging',
    'the event side panel with the full details and a link to the target',
    'the session policy page wired to the policies endpoint',
    'the sign-in policy page with two-factor for everyone and SAML enforcement',
    'the retention settings with the confirmation step',
    'the audit export dialog through the export job API',
    'the SIEM stream settings with a test delivery button',
    'the security overview page',
    'the residency badge and the region in workspace settings after the owner\'s change',
    'Playwright cases for every policy and the audit filters',
    'a pass on keyboard access in the audit table',
    'the bundle check after adding the console',
    'a last visual pass on the console and the audit table against the redlines',
  ]);
  x.tasks('comp-mobile', [
    'reading the policies endpoint on launch and on the policies.changed push',
    'ending the session in the app when the policy\'s session length or idle timeout is reached, keeping unsynced edits on the device',
    'requiring two-factor enrolment in the app when the workspace policy demands it for everyone',
    'managed app configuration from Intune and Jamf: allowed workspace, offline storage off, screenshots blocked',
    'blocking screenshots and the app switcher preview when the managed configuration asks for it',
    'refusing to open a workspace on an unmanaged device when the policy requires managed devices',
    'the remote sign-out push, which signs the app out within a minute and wipes pinned documents',
    'the messages for a session ended by policy and a device that is not managed',
    'testing with a real Intune tenant on an iPhone and an Android phone',
    'large-font passes for the policy messages',
    'Detox cases for session expiry by policy',
    'release builds 3.6.0 for TestFlight and the Play internal track, each with its own change ticket',
    'checking the messages in German and French',
    'the final review of the policy screens with design',
  ]);
  x.tasks('comp-infra', [
    'an inventory of every system that holds customer data or can change production: 14 AWS accounts, the CI system, Stripe, the email provider and the support tool',
    'production access through short-lived roles from the identity provider, with hardware keys for every engineer and no long-lived access keys',
    'central logging of AWS API calls, database access and admin tool use into a separate log account that engineers cannot change',
    'backups for every data store with a monthly restore test that leaves a record',
    'vulnerability scanning of images and dependencies with fix deadlines by severity: 7 days critical, 30 days high',
    'change management in CI: pull request reviews, deploy approvals and links from every deploy to its change',
    'the evidence jobs that write each control\'s evidence to the evidence bucket on a schedule',
    'endpoint management for team laptops with disk encryption and screen locks reported to the evidence bucket',
    'the incident response runbook and a tabletop exercise with the whole team',
    'vendor reviews for the 11 subprocessors that touch customer data',
    'the regional layout for EU workspaces after the owner\'s change',
    'the access review of production roles for the first quarter',
    'the infrastructure controls sign-off for 3.6',
    'the hand-over notes for the auditors',
  ]);
  x.tasks('comp-soc2', [
    'choosing the audit firm from three quotes, and the scope: security and availability criteria, all production systems',
    'the policy set: information security, access control, change management, incident response, vendor management, business continuity and data retention',
    'the control matrix mapping 82 controls to the trust services criteria, each with an owner and the evidence it leaves',
    'the evidence plan for the Type II observation window after the owner\'s change',
    'the onboarding and offboarding checklists for the team, with the access each role gets',
    'security awareness training for the team and the record of who completed it',
    'the risk assessment with the top twelve risks and their treatment, including where customer data may be copied for reporting',
    'the vendor list with the reports collected from each subprocessor',
    'the description of the system for the auditors: architecture, data flows and the regions after the residency change',
    'a mock audit with the firm\'s readiness checklist',
    'the gaps from the mock audit and who fixes each by when',
    'the trust centre page that answers the questionnaire questions publicly',
    'the evidence index for the auditors',
    'the hand-over notes for the observation window',
  ]);
  x.tasks('comp-tests', [
    'tracing CMP-01 to CMP-12 to test cases',
    'an event coverage check that performs each of the 64 actions and looks for its audit event',
    'audit API cases for filters, paging, the admin-only rule and members reading their own events',
    'hash chain cases with a tampered row in a staging copy',
    'policy cases for session length, idle timeout and two-factor for everyone on web and mobile',
    'managed device cases with the Intune test tenant',
    'SIEM stream cases with signed deliveries to a test Splunk and a test Datadog',
    'retention cases with a test clock past 400 days',
    'residency cases that check every store of an EU workspace after the move',
    'the morning sign-in peak load test with 3,000 events per second',
    'the regression run on export, offline, co-editing, billing and accounts',
    'the release pass on build 3.6.0-rc2',
    'the known-issues list for 3.6, shared with the audit firm',
    'the 3.6 sign-off notes that open the observation window',
  ]);

  x.start('comp-req', 'Starting the 3.6 compliance requirements with the last 30 enterprise security questionnaires.', 'comp-req: audit log; admin policies; retention; SOC 2; stories CMP-nn; questionnaire answers.');
  x.start('comp-audit', 'Starting the audit log with the event schema and the action names.', 'comp-audit: 64 actions; append-only store with hash chain; client library for every service; admin API; SIEM stream.', 'c-comp-audit-admin');
  x.start('comp-infra', 'Starting the infrastructure controls with an inventory of every system that holds customer data.', 'comp-infra: inventory; short-lived prod access; central logs; restore tests; vuln deadlines; change management; evidence jobs.', 'c-comp-infra-soc2');
  x.start('comp-soc2', 'Starting the SOC 2 work: scope, audit firm and the policy set.', 'comp-soc2: firm and scope; 7 policies; control matrix of 82 controls; evidence plan; mock audit.', 'c-comp-infra-soc2');
  x.tick('comp-req', 'comp-audit', 'comp-infra', 'comp-soc2');
  x.qa({
    from: 'analyst', ws: 'comp-req', to: 'backend', toWs: 'comp-audit',
    reply: 'Writing the audit log stories.',
    q: 'which of the events customers ask for can we record today without new work in the services: SAML configuration changes, two-factor resets, role changes, exports, offline wipes?',
    a: 'Role changes and session revocations are already recorded by the identity service since 3.1, but in its own table without an actor IP. SAML configuration, two-factor resets, exports and offline wipes are recorded nowhere yet. Everything goes through the new client library, so the stories can assume all 64 actions.',
  });
  x.tick('comp-req', 'comp-audit', 'comp-soc2');
  x.start('comp-ux', 'Starting the admin console by mapping today\'s scattered settings to the questionnaires.', 'comp-ux: one console; audit table with filters and side panel; policy pages; retention; overview.', 'comp-req');
  x.tick('comp-ux', 'comp-req', 'comp-infra');
  x.dv('comp-req', 'First version of the 3.6 compliance requirements: the audit log, admin policies, retention and the security overview, with the events taken from the questionnaires.', 'Audit log, admin policies, retention; CMP-01 to CMP-08',
    'Audit log: CMP-01 an owner or admin searches audit events by person, action and time range; CMP-02 exports them as JSON lines; CMP-03 streams them to Splunk, Datadog or Sentinel. Recorded actions include sign-ins and failed sign-ins, two-factor changes, SAML configuration, role changes, billing changes, sharing with outside reviewers, exports and remote wipes of offline devices.',
    'Policies and retention: CMP-04 set the session length (1 to 30 days) and idle timeout; CMP-05 require two-factor for everyone; CMP-06 restrict sign-up to verified email domains; CMP-07 set retention for trashed documents and removed members\' data; CMP-08 a security overview that shows the state of each control a questionnaire asks about.',
  );
  x.rev('comp-req', false, 'Good list. But there is no rule for who can read the audit log, and an admin who changes their own role or removes their own access must not be able to hide it. Spell out the access rules and that the log cannot be edited by anyone, us included.');
  x.tick('comp-req', 'comp-ux', 'comp-audit');
  x.dv('comp-req', 'Added the access rules and tamper resistance to the audit log stories.', 'Audit log access rules; append-only for everyone',
    'Access: only owners and admins read the workspace audit log, checked on the server; members read only events about themselves on their account page. The log is append-only for everyone, Quire staff included; an admin who changes their own role or removes their own access is recorded like anyone else, and the event cannot be deleted before its retention ends. CMP-09 a nightly check proves no event was changed or removed.',
  );
  x.rev('comp-req', true, 'Approved as the 3.6 baseline.');
  x.tick('comp-audit', 'comp-infra');

  // Change 1: SOC 2 Type II
  b.human(
    'Change of plan on the audit (CHANGE-SOC2-TYPE2): two of the enterprise renewals will not accept a Type I report; they want SOC 2 Type II. That means a three-month observation window in which every control runs and leaves evidence, and the window has to start the day 3.6 ships. So instead of preparing for a point-in-time audit, every control must be running and producing evidence automatically by release day.',
  );
  b.fact('change-soc2-type2', 'CHANGE-SOC2-TYPE2', ['*'], {
    question: 'Which SOC 2 report type must we deliver? Give only the current value.',
    expect: ['Type II'],
    reject: ['Type I'],
  });
  b.replan({
    workstreams: b.currentPlan.workstreams.map(w =>
      w.id === 'comp-soc2'
        ? { ...w, brief: 'Write the security policies, map Quire\'s controls to the SOC 2 trust services criteria and set up continuous evidence collection so the three-month Type II observation window can start on the 3.6 release day.' }
        : w.id === 'comp-infra'
          ? { ...w, brief: 'Put the infrastructure controls in place and make each one run continuously and leave evidence for the Type II window: production access, logging, backups and restores, vulnerability management and change management.' }
          : w.id === 'comp-req'
            ? { ...w, brief: 'Write the 3.6 requirements for the audit log, admin security policies and SOC 2 Type II readiness with continuous evidence, as stories CMP-nn with acceptance checklists.' }
            : w,
    ),
    contracts: [
      ...b.currentPlan.contracts,
      { id: 'c-comp-audit-soc2', from: 'comp-audit', to: 'comp-soc2', spec: 'Audit events of Quire staff actions (support access to a workspace, production database access) are recorded like customer events and copied daily to the evidence bucket for the observation window.' },
    ],
  });
  x.tick('comp-soc2', 'comp-infra', 'comp-audit', 'comp-ux');
  x.qa({
    from: 'analyst', ws: 'comp-soc2', to: 'ops', toWs: 'comp-infra',
    reply: 'Writing the evidence plan for the observation window.',
    q: 'which controls can produce their evidence automatically from day one, and which still need someone to take a screenshot?',
    a: 'Automatic from day one: production access grants (from the identity provider logs), deploys with their reviews, vulnerability scans, backup and restore tests and laptop disk encryption. Still manual: the quarterly access review and the tabletop exercise; I will give both a form that writes to the evidence bucket so nobody screenshots anything.',
  });
  x.record({ id: 'c-comp-evidence-soc2', from: 'comp-infra', to: 'comp-soc2', spec: 'Production access, deploys and their reviews, vulnerability scans, backup and restore tests and laptop encryption write evidence automatically every day; the access review and the tabletop exercise write theirs through a form; all of it lands in the evidence bucket under <control id>/<YYYY-MM-DD>/.' });
  x.tick('comp-soc2', 'comp-infra', 'comp-req');
  x.dv('comp-soc2', 'First version of the SOC 2 policies and control matrix, set up for the Type II window after the owner\'s change.', 'Policy set, control matrix of 82 controls, evidence plan',
    'Policies: information security, access control, change management, incident response, vendor management, business continuity and data retention, each approved by the owner and acknowledged by the team. The control matrix maps 82 controls to the security and availability criteria, each with an owner, a frequency and the evidence it leaves.',
    'Evidence plan for the Type II window starting on release day: 61 controls leave evidence automatically every day or on every event; 21 are periodic (quarterly or yearly) and write through forms. The audit firm samples from the evidence bucket without asking engineers.',
  );
  x.rev('comp-soc2', false, 'The matrix lists "quarterly review of access" without saying what is reviewed, by whom, and what happens to access nobody can justify. The auditor will sample exactly this control first, and our 3.1 admin and SAML rules depend on it.', [
    'Every quarter the owner of each system reviews who has production, admin-tool and Stripe access; access nobody can justify is removed within 5 working days, and the review is recorded with the reviewer, the date and the removals (CONV-ACCESS-REVIEW).',
  ]);
  b.fact('conv-access-review', 'CONV-ACCESS-REVIEW', ['ops', 'analyst', 'backend'], {
    question: 'How often is production access reviewed, and within how many working days is access nobody can justify removed?',
    expect: ['every quarter', '5 working days'],
  });
  x.tick('comp-soc2', 'comp-audit', 'comp-ux', 'comp-infra', 'comp-req');
  x.start('comp-admin', 'Starting the admin console in the web app against the audit and policy endpoints.', 'comp-admin: console shell for owners/admins; audit table with server filters; policy pages; retention; overview.', 'c-comp-audit-admin');
  x.start('comp-mobile', 'Starting the admin policies in the apps and managed app configuration.', 'comp-mobile: policies endpoint + push; session end by policy; two-factor required; Intune/Jamf config; remote sign-out.', 'c-comp-audit-mobile');
  x.start('comp-tests', 'Starting the 3.6 test plan with an event coverage check.', 'comp-tests: trace CMP-nn; perform all 64 actions; audit API; hash chain; policies on every platform; SIEM.', 'c-comp-req-tests');
  x.tick('comp-audit', 'comp-infra', 'comp-admin', 'comp-mobile', 'comp-tests');
  x.qa({
    from: 'web', ws: 'comp-admin', to: 'backend', toWs: 'comp-audit',
    reply: 'Building the audit table filters.',
    q: 'can the audit endpoint filter by several actions at once and by a prefix such as member., or should the console send one request per action?',
    a: 'Both: action accepts a comma-separated list and a trailing dot as a prefix, so action=member.,sso. returns every member and SAML event. Times are ISO 8601 UTC bounds, from inclusive and to exclusive, and paging is by cursor with at most 200 events per page.',
  });
  x.tick('comp-admin', 'comp-mobile', 'comp-ux', 'comp-mobile');
  x.dv('comp-ux', 'First version of the admin console and audit log designs.', 'Console navigation, audit viewer, policy pages, retention, overview',
    'Console: one place for owners and admins with overview, members, security policies, audit log, data and retention, and billing. The audit log is a dense table of time, person, action and target with filters on each and a side panel with the full event, its IP and device; the export button opens a dialog with the time range.',
    'Policies: session length and idle timeout with a sentence that explains each choice, two-factor for everyone, SAML enforcement with the break-glass owner and allowed email domains. Retention settings name exactly what will be deleted before saving. The overview lists each control a questionnaire asks about with its state.',
  );
  x.rev('comp-ux', true, 'Approved; the overview answered every question in the mock questionnaire.');
  x.tick('comp-ux', 'comp-req', 'comp-tests', 'comp-admin', 'comp-mobile');
  x.status('Two weeks into 3.6. Status from each of you, please, and what the Type II window means for your work.', ['comp-req', 'comp-ux', 'comp-audit', 'comp-admin', 'comp-mobile', 'comp-infra', 'comp-soc2', 'comp-tests']);
  x.tick('comp-audit', 'comp-soc2', 'comp-infra', 'comp-admin');

  // Change 2: EU data residency
  b.human(
    'Change of requirements (CHANGE-EU-RESIDENCY): our German and Dutch enterprise customers, and 11 of the last 30 questionnaires, require that their data stays in the EU. From 3.6 every EU workspace is stored in eu-central-1 (Frankfurt): documents, attachments, sync servers, search, exports, backups and logs, no copies elsewhere. Existing EU workspaces move there without downtime. This replaces our single-region setup in us-east-1 for those customers.',
  );
  b.fact('change-eu-residency', 'CHANGE-EU-RESIDENCY', ['*'], {
    question: 'In which region must EU workspaces be stored? Give only the current value.',
    expect: ['eu-central-1', 'Frankfurt'],
  });
  b.replan({
    workstreams: [...b.currentPlan.workstreams, COMP_RESIDENCY].map(w =>
      w.id === 'comp-tests' ? { ...w, dependsOn: ['comp-admin', 'comp-mobile', 'comp-audit', 'comp-residency'] } : w,
    ),
    contracts: [
      ...b.currentPlan.contracts,
      { id: 'c-comp-residency-audit', from: 'comp-residency', to: 'comp-audit', spec: 'Each workspace has a region, us or eu, fixed at creation and readable from GET /v2/workspaces/{id}; every service stores and processes the workspace\'s data only in that region, including audit events, export files and backups.' },
      { id: 'c-comp-residency-admin', from: 'comp-residency', to: 'comp-admin', spec: 'The region and the date of a completed move are part of the workspace response, so the console can show a residency badge; a move in progress is shown as such.' },
    ],
  });
  x.tasks('comp-residency', [
    'the list of every store and processor that holds workspace data: Postgres, the updates table, attachments, search, the export bucket, the sync servers, backups, logs and the email provider',
    'the Frankfurt region built from the same Terraform modules as us-east-1, with its own sync fleet and render workers',
    'routing at the gateway by the workspace region, so every request and websocket for an EU workspace is served in Frankfurt',
    'the move of one EU workspace: copy, catch up, switch the region with a 20-second write pause, delete the US copy',
    'moving the 1,140 existing EU workspaces in nightly batches of 150',
    'backups of EU data kept in eu-central-1 and a second EU region only',
    'the reporting replica and analytics exports, which must stay in the region of the data',
    'logs that contain document titles or emails kept in the region of the workspace',
    'a residency check that scans every store for EU workspace ids outside the EU',
    'the subprocessor list per region for the trust centre',
    'the runbook for a failed workspace move',
    'the residency sign-off for 3.6 after the last batch of moves',
  ]);
  x.start('comp-residency', 'Starting EU data residency with a list of every place workspace data lives today.', 'comp-residency: inventory of stores; Frankfurt from same Terraform; gateway routing by region; move per workspace; residency check.', 'c-comp-residency-audit');
  x.dv('comp-req', 'Added the residency stories after the owner\'s change and the Type II stories.', 'EU residency CMP-10 and CMP-11; continuous evidence CMP-12',
    'Residency: CMP-10 an EU workspace\'s documents, attachments, search, exports, audit events, backups and logs are stored and processed only in eu-central-1, and the console shows the region and when the workspace moved; CMP-11 existing EU workspaces move with at most 30 seconds of read-only time. CMP-12 every control in the matrix produces its evidence without manual screenshots from the first day of the Type II window.',
  );
  x.rev('comp-req', true, 'Approved. This matches the owner\'s two changes.');
  x.tick('comp-residency', 'comp-req', 'comp-ux', 'comp-admin', 'comp-mobile', 'comp-audit');
  x.qa({
    from: 'ops', ws: 'comp-residency', to: 'backend', toWs: 'comp-audit',
    reply: 'Planning the workspace move.',
    q: 'can a workspace stop accepting writes for 20 seconds while the region switches, and what do open sockets and clients with offline edits see during that time?',
    a: 'Yes: the sync server closes every socket of the workspace with REGION_MOVING, clients back off and reconnect to Frankfurt once the gateway routes there. Offline edits wait on the device and go out after the state vector exchange with the new region, so nothing is lost. API writes get 503 with Retry-After: 30.',
  });
  x.record({ id: 'c-comp-move-clients', from: 'comp-residency', to: 'comp-mobile', spec: 'During a region move the sync server closes the workspace\'s sockets with REGION_MOVING and API writes return 503 with Retry-After: 30; clients keep their unsent edits and reconnect when the gateway routes the workspace to its new region.' });
  x.tick('comp-residency', 'comp-audit', 'comp-mobile', 'comp-admin');
  x.dv('comp-audit', 'First version of the audit log service: schema, append-only store with a hash chain, events from every service, the admin API and the export.', 'Audit store, 64 actions, admin API, JSON lines export',
    'Store: audit events follow the agreed schema and go into an append-only Postgres table written through an insert-only role, partitioned by month, with a hash chain per workspace so a changed or removed row breaks the chain. All services emit through one client library; 64 actions cover identity, two-factor, SAML, roles, billing, sharing, document roles, exports and offline wipes.',
    'API: GET /v2/workspaces/{id}/audit-events accepts lists and prefixes of actions, actor and ISO 8601 UTC bounds, pages by cursor and is restricted to owners and admins by the server-side role check; members get their own events on the account page. Exports run through the export job queue as JSON lines, named with the shared file name pattern.',
  );
  x.rev('comp-audit', false, 'The store is solid, but the SIEM stream posts events to customer URLs with nothing that proves they came from us, and a retried batch arrives twice. We set the rule for incoming webhooks in 3.2; outgoing ones need the same care.');
  x.tick('comp-audit', 'comp-admin', 'comp-tests');
  x.dv('comp-audit', 'Signed the SIEM stream and made its deliveries safe to repeat.', 'Signed SIEM deliveries with batch ids; policies endpoint',
    'SIEM stream: batches of events every 30 seconds are signed with a per-customer secret in a Quire-Signature header (HMAC-SHA256 over the timestamp and body, 5-minute tolerance), the same scheme we verify on incoming webhook signature checks, and carry a batch id so a retried batch can be dropped by the receiver. GET /v2/workspaces/{id}/policies and the policies.changed push serve session and sign-in policies; the identity service refuses refresh tokens older than the session length.',
  );
  x.rev('comp-audit', true, 'Approved. Signed batches with ids match what we ask of anyone who sends us webhooks.');
  x.tick('comp-infra', 'comp-soc2', 'comp-residency', 'comp-mobile', 'comp-audit', 'comp-req');
  b.work('ops', 'comp-residency', 'Recording a failed approach (FAIL-US-READ-REPLICA): for the first moved test workspaces I kept our reporting read replica in us-east-1, fed by logical replication from Frankfurt. The residency check flagged it on the first night: the replica held full copies of EU documents in the US, which is exactly what the customers ruled out. Replicas, analytics exports and their backups now stay in the region of the data, and cross-region reporting reads only aggregated counts.', [
    op.failure(
      'Keeping the reporting read replica in us-east-1 fed by logical replication from eu-central-1 (FAIL-US-READ-REPLICA).',
      'The replica held full copies of EU workspace data in the US, breaking the residency promise; replicas and analytics exports must stay in the data\'s region, and cross-region reports may only read aggregates.',
      ['comp-residency'],
    ),
  ]);
  b.fact('fail-us-read-replica', 'FAIL-US-READ-REPLICA', ['ops', 'backend', 'analyst'], {
    question: 'Which placement of the reporting replica broke the residency check?',
    expect: ['us-east-1'],
  });
  x.tick('comp-residency', 'comp-admin', 'comp-ux', 'comp-audit', 'comp-infra', 'comp-tests');
  x.dv('comp-infra', 'First version of the infrastructure controls, each leaving evidence for the observation window.', 'Production access, central logs, restores, vulnerability deadlines, change management',
    'Access and logging: production access only through short-lived roles from the identity provider with hardware keys; no long-lived access keys remain. AWS API calls, database access and admin tool use go to a separate log account engineers cannot change. Every data store has backups and a monthly restore test that writes its result to the evidence bucket.',
    'Vulnerabilities and changes: images and dependencies are scanned on every build, with fix deadlines of 7 days for critical and 30 days for high findings. Deploys come from CI after a reviewed pull request; the deploy record is copied to the evidence bucket daily.',
  );
  x.rev('comp-infra', false, 'Close, but an auditor will pick a deploy and ask why it was made and who approved it. A reviewed pull request says what changed, not why or who signed it off; emergency fixes at night skip review today.', [
    'Every production change, deploys and infrastructure changes alike, links a change ticket that says why, has an approver other than the author and records the result; an emergency change gets its ticket and approval within one working day (CONV-CHANGE-TICKET).',
  ]);
  b.fact('conv-change-ticket', 'CONV-CHANGE-TICKET', ['ops', 'backend', 'web', 'mobile'], {
    question: 'What must every production change link?',
    expect: ['change ticket'],
  });
  x.tick('comp-infra', 'comp-tests', 'comp-req', 'comp-mobile');
  x.qa({
    from: 'mobile', ws: 'comp-mobile', to: 'ops', toWs: 'comp-infra',
    reply: 'Preparing the app release for the Type II window.',
    q: 'does an app store release count as a production change? It goes through review by Apple and Google, not through our deploy pipeline.',
    a: 'Yes: every TestFlight and Play release needs a change ticket with the build number, an approver other than you, and the phased rollout plan. The store review is not our approval. I added a release template to the ticket system that fills in the build from CI.',
  });
  x.tick('comp-mobile', 'comp-infra', 'comp-soc2');
  x.dv('comp-infra', 'Added change tickets to every production change.', 'Change tickets with approvers for deploys, infrastructure and app releases',
    'Changes: every deploy, Terraform apply and app store release links a change ticket with the reason, an approver other than the author and the result; CI refuses a production deploy without an approved ticket, and an emergency deploy opens one that must be approved within a working day. The quarterly access review, the incident tabletop and the restore tests write their records through forms into the evidence bucket.',
  );
  x.rev('comp-infra', true, 'Approved. CI refusing a deploy without a ticket is the control the auditor will test.');
  x.tick('comp-soc2', 'comp-residency', 'comp-ux', 'comp-admin');
  x.dv('comp-soc2', 'Added the quarterly access review and the system description for the auditors.', 'Access review procedure; system description with regions',
    'Access review: every quarter the owner of each system (AWS, the admin tool, Stripe, the support tool, the identity provider) reviews who has access; unjustified access is removed within 5 working days and the review is recorded with reviewer, date and removals. System description: architecture, data flows and the two regions, us-east-1 and eu-central-1 for EU workspaces, for the Type II window starting on release day.',
  );
  x.rev('comp-soc2', true, 'Approved. The mock audit found no gap in these controls.');
  x.tick('comp-soc2', 'comp-admin', 'comp-mobile', 'comp-audit');
  x.status('Week four of 3.6. Status from each of you, please, and say if residency puts the release date at risk.', ['comp-req', 'comp-ux', 'comp-audit', 'comp-admin', 'comp-mobile', 'comp-infra', 'comp-soc2', 'comp-residency', 'comp-tests']);
  x.tick('comp-residency', 'comp-tests', 'comp-ux');
  x.qa({
    from: 'qa', ws: 'comp-tests', to: 'ops', toWs: 'comp-residency',
    reply: 'Writing the residency cases.',
    q: 'how can a test prove that nothing of an EU workspace is left outside the EU, rather than checking the stores we already know about?',
    a: 'Run the residency check against staging after the move: it scans every Postgres database, bucket, search index and log group in every region for the workspace id and its document ids, and fails on any hit outside the EU. It found the us-east-1 read replica the first night, so it does look in places we forget.',
  });
  x.tick('comp-residency', 'comp-admin', 'comp-tests');
  x.dv('comp-residency', 'First version of EU data residency: the Frankfurt region, routing by workspace region, the move procedure and the residency check.', 'Frankfurt region, routing by region, workspace moves, residency check',
    'Region: eu-central-1 is built from the same Terraform modules as us-east-1, with its own Postgres, attachments, search, sync fleet, render workers and export bucket; backups go to eu-central-1 and eu-west-1 only. The gateway routes every request and websocket by the workspace region, not by sticky sessions or the user\'s location.',
    'Moves: a workspace is copied, caught up, paused for writes for about 20 seconds while the region switches, and its US copy is deleted after a verification; the 1,140 existing EU workspaces move in nightly batches of 150. A residency check scans every store in every region each night and fails on any EU workspace data outside the EU; replicas and analytics exports stay in the region of their data.',
  );
  x.rev('comp-residency', true, 'Approved. The nightly residency check is the strongest evidence we have.');
  x.tick('comp-residency', 'comp-admin', 'comp-req', 'comp-mobile', 'comp-infra');
  x.dv('comp-admin', 'First version of the web admin console: audit viewer, policies, retention, SIEM settings, overview and the residency badge.', 'Admin console with audit viewer, policies, retention, SIEM, overview',
    'Audit viewer: the table sends its filters to the server (lists and prefixes of actions, actor, time range) and pages by cursor; the side panel shows the full event. Exports go through the export job API. Only owners and admins see the console; the server checks the role on every request.',
    'Settings: session length and idle timeout, two-factor for everyone, SAML enforcement with the break-glass owner, allowed domains, retention with a confirmation that names what will be deleted, SIEM stream settings with a test delivery, the security overview and the residency badge with the region and the date of the move.',
  );
  x.rev('comp-admin', false, 'The table keeps the last 2,000 events in localStorage to make the back button fast. That puts audit data with IPs and emails in browser storage on whatever computer the admin used, and we learned in 3.4 what localStorage does at its limit. Keep nothing there.', [
    'Clients keep customer data in browser storage only for pinned offline documents; everything else stays in memory for the open tab.',
  ]);
  x.tick('comp-admin', 'comp-ux', 'comp-tests');
  x.dv('comp-admin', 'Removed browser storage of audit data from the console.', 'No audit data in browser storage; filters in the URL',
    'Storage: the audit viewer keeps events only in memory for the open tab; filters and the cursor live in the URL, so the back button restores the same page with one request instead of a stored copy. Nothing from the console is written to localStorage or IndexedDB, and the service worker never caches audit responses.',
  );
  x.rev('comp-admin', true, 'Approved. Filters in the URL are better than the stored copy anyway.');
  x.tick('comp-mobile', 'comp-tests', 'comp-ux', 'comp-soc2');
  x.dv('comp-mobile', 'First version of the policies in the apps and managed app configuration.', 'Session policies, two-factor for everyone, Intune and Jamf configuration, remote sign-out',
    'Policies: the apps read GET /v2/workspaces/{id}/policies on launch and on the policies.changed push; a session that reaches the policy\'s length or idle timeout ends with a message, and unsynced edits stay on the device until the person signs in again. When two-factor is required for everyone, the app asks for enrolment before opening the workspace.',
    'Managed devices: Intune and Jamf can set the allowed workspace, turn offline storage off and block screenshots and the app switcher preview; a workspace that requires managed devices refuses to open on an unmanaged one. The remote sign-out push signs the app out within a minute and wipes pinned documents. Tested with a real Intune tenant on both platforms.',
  );
  x.rev('comp-mobile', true, 'Approved. Testing against a real Intune tenant removes the biggest unknown.');
  x.tick('comp-tests', 'comp-req', 'comp-ux', 'comp-mobile', 'comp-soc2', 'comp-residency');
  x.status('Last week of 3.6 and of this year\'s release plan. One line each on what is left, please.', ['comp-req', 'comp-ux', 'comp-audit', 'comp-admin', 'comp-mobile', 'comp-infra', 'comp-soc2', 'comp-residency', 'comp-tests']);
  x.tick('comp-tests', 'comp-req', 'comp-ux', 'comp-admin', 'comp-soc2', 'comp-residency');
  x.dv('comp-tests', 'First version of the 3.6 test plan and the first run, with story and build on every result.', 'Plan traced to CMP-01..CMP-12; event coverage; first run',
    'Plan: CMP-01 to CMP-12 trace to 118 automated cases; the event coverage check performs all 64 actions and looks for each audit event; policy cases run on the web and both apps; residency cases run the residency check after moving three staging workspaces.',
    'First run, CMP-01 / build 3.6.0-rc1: 113 of 118 pass. Failures: CMP-01 / build 3.6.0-rc1, offline remote wipes are recorded without the device name; CMP-11 / build 3.6.0-rc1, one moved workspace kept its search index in us-east-1; CMP-04 / build 3.6.0-rc1, the idle timeout ends Android sessions 60 seconds early; two flaky SIEM delivery waits.',
  );
  x.rev('comp-tests', false, 'The coverage check is excellent. But nothing tests the hash chain against tampering or the 400-day retention, and those are the two properties we promise auditors and customers about the log.');
  x.tick('comp-tests', 'comp-req', 'comp-tests', 'comp-residency');
  x.dv('comp-tests', 'Added tamper and retention cases; release pass on rc2.', 'Hash chain tampering, 400-day retention; release pass on 3.6.0-rc2',
    'New cases: a row changed and a row deleted directly in a staging copy both break the hash chain and raise the alert within the nightly check; with a test clock past 400 days the oldest events are deleted and the chain restarts from a signed checkpoint; an Enterprise workspace with a 3-year setting keeps them.',
    'Release pass on build 3.6.0-rc2: 124 of 124 automated cases pass, including CMP-01 / build 3.6.0-rc1, CMP-11 / build 3.6.0-rc1 (the search index now moves with the workspace) and CMP-04 / build 3.6.0-rc1, now fixed. Known issue: CMP-03 / build 3.6.0-rc2, the Sentinel test delivery shows success before Sentinel confirms it.',
  );
  x.rev('comp-tests', true, 'Approved for release. The Type II window starts with this build.');
  x.close('comp-');
  b.human('Quire 3.6 ships on Monday and the SOC 2 observation window starts the same day. Six releases in one year with the same team: accounts, billing, collaboration, offline, export and compliance. Thank you all.');
}
