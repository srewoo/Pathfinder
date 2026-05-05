import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InteractionGraph, TestCase } from '../../../src/storage/schemas';

const MOCK_TAB_ID = 1;

// --- Module mocks (must be declared before dynamic imports) ---

vi.mock('../../../src/messaging/messenger', () => ({
  getActiveTabId: vi.fn(),
}));

vi.mock('../../../src/storage/indexed-db', () => ({
  testCaseDB: { put: vi.fn() },
}));

vi.mock('../../../src/core/explorer/page-scanner', () => ({
  getPageSnapshot: vi.fn(),
}));

vi.mock('../../../src/core/explorer/interaction-graph', () => ({
  loadGraph: vi.fn().mockResolvedValue(undefined),
  extractAllFormFields: vi.fn().mockReturnValue('No form fields captured.'),
}));

vi.mock('../../../src/core/flow/flow-store', () => ({
  getAllFlows: vi.fn().mockResolvedValue([]),
  serializeFlowsForAI: vi.fn().mockReturnValue('No learned flows available.'),
}));

vi.mock('../../../src/core/knowledge/vector-search', () => ({
  searchByText: vi.fn(),
  formatSearchResults: vi.fn(),
}));

vi.mock('../../../src/core/planner/plan-cache', () => ({
  computePlanHash: vi.fn(),
  getCachedPlan: vi.fn(),
  cachePlan: vi.fn(),
}));

vi.mock('../../../src/utils/dom-compress', () => ({
  serializeCompressedDOM: vi.fn(),
}));

const { planTest } = await import('../../../src/core/planner/test-planner');
const { getPageSnapshot } = await import('../../../src/core/explorer/page-scanner');
const { loadGraph, extractAllFormFields } = await import('../../../src/core/explorer/interaction-graph');
const { getAllFlows, serializeFlowsForAI } = await import('../../../src/core/flow/flow-store');
const { searchByText, formatSearchResults } = await import('../../../src/core/knowledge/vector-search');
const { computePlanHash, getCachedPlan, cachePlan } = await import('../../../src/core/planner/plan-cache');
const { serializeCompressedDOM } = await import('../../../src/utils/dom-compress');

const mockAIClient = {
  chat: vi.fn(),
  embed: vi.fn(),
};

const baseTestCase: TestCase = {
  id: 'tc-001',
  title: 'User can log in',
  description: 'Verify a valid user can log in with correct credentials',
  type: 'positive',
  source: 'generated',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const mockPlanSteps = [
  { order: 1, action: 'navigate', value: 'https://example.com/login', description: 'Go to login page' },
  { order: 2, action: 'type', selector: '#email', value: 'user@test.com', description: 'Enter email' },
  { order: 3, action: 'type', selector: '#password', value: 'secret', description: 'Enter password' },
  { order: 4, action: 'click', selector: 'button[type="submit"]', description: 'Submit form' },
  { order: 5, action: 'assert', selector: '.dashboard', assertType: 'visible', description: 'Dashboard visible' },
];

const validAIResponse = JSON.stringify({ steps: mockPlanSteps });

const cachedPlan = {
  id: 'plan-001',
  testCaseId: 'tc-001',
  testCaseHash: 'hash-abc',
  steps: mockPlanSteps,
  cachedAt: new Date().toISOString(),
};

function setupDefaultMocks() {
  vi.mocked(getPageSnapshot).mockResolvedValue({
    url: 'https://example.com/login',
    title: 'Login Page',
    elements: [],
    domCompressed: '<form><input id="email"/><input id="password"/><button>Login</button></form>',
    capturedAt: new Date().toISOString(),
  });
  vi.mocked(searchByText).mockResolvedValue([]);
  vi.mocked(formatSearchResults).mockReturnValue('');
  vi.mocked(loadGraph).mockResolvedValue(undefined);
  vi.mocked(extractAllFormFields).mockReturnValue('No form fields captured.');
  vi.mocked(getAllFlows).mockResolvedValue([]);
  vi.mocked(serializeFlowsForAI).mockReturnValue('No learned flows available.');
  vi.mocked(computePlanHash).mockResolvedValue('hash-abc');
  vi.mocked(getCachedPlan).mockResolvedValue(undefined);
  vi.mocked(serializeCompressedDOM).mockReturnValue('<compressed-dom/>');
  vi.mocked(cachePlan).mockImplementation(async (_testCaseId, hash, partial) => ({
    id: 'plan-001',
    testCaseId: _testCaseId,
    testCaseHash: hash,
    steps: partial.steps,
    cachedAt: new Date().toISOString(),
  }));
  mockAIClient.chat.mockResolvedValue(validAIResponse);
  mockAIClient.embed.mockResolvedValue([0.1, 0.2, 0.3]);
}

function makeNavigationGraph(): InteractionGraph {
  return {
    nodes: [
      {
        id: 'dashboard',
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
        visitedAt: new Date().toISOString(),
        elementCount: 6,
      },
      {
        id: 'call-ai',
        url: 'https://app.example.com/call-ai',
        title: 'Call AI DSR Coaching',
        visitedAt: new Date().toISOString(),
        elementCount: 8,
      },
    ],
    edges: [
      {
        from: 'https://app.example.com/dashboard',
        to: 'https://app.example.com/call-ai',
        action: 'click',
        selector: '[data-testid="call-ai-link"]',
        label: 'Call AI DSR Coaching',
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('planTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('given valid test case when no cached plan then calls AI and returns plan', async () => {
    const plan = await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID);

    expect(plan).toBeDefined();
    expect(plan.steps).toHaveLength(5);
    expect(plan.testCaseId).toBe('tc-001');
    expect(mockAIClient.chat).toHaveBeenCalledOnce();
    expect(cachePlan).toHaveBeenCalledOnce();
  });

  it('given cached plan exists when planning then returns cache without calling AI', async () => {
    vi.mocked(getCachedPlan).mockResolvedValue(cachedPlan as never);

    const plan = await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID);

    expect(plan).toEqual(cachedPlan);
    expect(mockAIClient.chat).not.toHaveBeenCalled();
    expect(cachePlan).not.toHaveBeenCalled();
  });

  it('given AI returns valid JSON wrapped in markdown when planning then parses correctly', async () => {
    mockAIClient.chat.mockResolvedValue('```json\n' + validAIResponse + '\n```');

    const plan = await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID);

    expect(plan.steps).toHaveLength(5);
    expect(plan.steps[0].action).toBe('navigate');
  });

  it('given no DOM snapshot when planning then uses fallback context message', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue(null);

    await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID);

    expect(serializeCompressedDOM).not.toHaveBeenCalled();
    expect(mockAIClient.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('No DOM snapshot available'),
        }),
      ]),
      expect.any(Object)
    );
  });

  it('given AI returns invalid JSON when planning then throws descriptive error', async () => {
    mockAIClient.chat.mockResolvedValue('not-json at all!!!');

    await expect(planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID)).rejects.toThrow(
      'AI returned an empty execution plan'
    );
  });

  it('given AI returns JSON with empty steps array when planning then throws error', async () => {
    mockAIClient.chat.mockResolvedValue(JSON.stringify({ steps: [] }));

    await expect(planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID)).rejects.toThrow(
      'AI returned an empty execution plan'
    );
  });

  it('given AI call throws when planning then re-throws with context', async () => {
    mockAIClient.chat.mockRejectedValue(new Error('Rate limited'));

    await expect(planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID)).rejects.toThrow(
      'Test planning failed: Rate limited'
    );
  });

  it('given test case with expected steps when planning then includes steps in prompt', async () => {
    const testCaseWithSteps = {
      ...baseTestCase,
      steps: ['Navigate to login', 'Enter credentials', 'Click submit'],
    };

    await planTest(testCaseWithSteps, mockAIClient as never, MOCK_TAB_ID);

    const chatCall = mockAIClient.chat.mock.calls[0];
    const userMessage = chatCall[0].find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toContain('Expected steps');
    expect(userMessage.content).toContain('Navigate to login');
  });

  it('given execution preset metadata when planning then includes setup and persona context in prompt', async () => {
    const presetBackedTest = {
      ...baseTestCase,
      executionPresetName: 'Admin authenticated',
      personaLabel: 'Admin',
      requiresAuthenticatedSession: true,
      setupNotes: 'Feature flag "projects-v2" must be enabled.',
      setupSteps: ['Sign in as admin', 'Open the Projects workspace'],
    };

    await planTest(presetBackedTest, mockAIClient as never, MOCK_TAB_ID);

    const chatCall = mockAIClient.chat.mock.calls[0];
    const userMessage = chatCall[0].find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toContain('Execution preset: Admin authenticated');
    expect(userMessage.content).toContain('Persona: Admin');
    expect(userMessage.content).toContain('[Setup] Sign in as admin');
    expect(userMessage.content).toContain('authenticated before the main scenario starts');
  });

  it('given AI invents a route when explored navigation exists then rewrites navigate into known click path', async () => {
    vi.mocked(getPageSnapshot).mockResolvedValue({
      url: 'https://app.example.com/dashboard',
      title: 'Dashboard',
      elements: [],
      domCompressed: '<nav><a data-testid="call-ai-link">Call AI DSR Coaching</a></nav>',
      capturedAt: new Date().toISOString(),
    });
    vi.mocked(loadGraph).mockResolvedValue(makeNavigationGraph());

    mockAIClient.chat.mockResolvedValue(
      JSON.stringify({
        steps: [
          {
            order: 1,
            action: 'navigate',
            value: 'https://app.example.com/call-ai-dsr-coaching',
            description: 'Open the Call AI DSR Coaching page',
          },
          {
            order: 2,
            action: 'assert',
            selector: '[data-testid="coaching-page"]',
            assertType: 'visible',
            description: 'Coaching page is visible',
          },
        ],
      })
    );

    const plan = await planTest(
      {
        ...baseTestCase,
        title: 'Open Call AI DSR Coaching',
        description: 'Verify the user can open Call AI DSR Coaching from the dashboard',
      },
      mockAIClient as never,
      MOCK_TAB_ID
    );

    expect(plan.steps[0].action).toBe('click');
    expect(plan.steps[0].selector).toBe('[data-testid="call-ai-link"]');
    expect(plan.steps[0].description).toContain('Call AI DSR Coaching');
    expect(plan.steps[1].action).toBe('assert');
  });

  it('given plan with unknown action types when parsing then defaults to click', async () => {
    const stepsWithBadAction = [
      { order: 1, action: 'unknown_action', selector: '#btn', description: 'Do something' },
    ];
    mockAIClient.chat.mockResolvedValue(JSON.stringify({ steps: stepsWithBadAction }));

    const plan = await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID);

    expect(plan.steps[0].action).toBe('click');
  });

  it('given knowledge results exist when planning then includes them in prompt', async () => {
    vi.mocked(formatSearchResults).mockReturnValue('Relevant doc: Login requires valid email.');
    vi.mocked(searchByText).mockResolvedValue([
      {
        record: { id: 'v1', content: 'Relevant doc text', url: 'https://docs.example.com', embedding: [], metadata: { title: 'Login', section: '', crawledAt: '', chunkIndex: 0, totalChunks: 1 } },
        score: 0.9,
      },
    ]);

    await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID);

    const chatCall = mockAIClient.chat.mock.calls[0];
    const userMessage = chatCall[0].find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toContain('Relevant doc: Login requires valid email.');
  });

  it('given plan has assert step with bad assertType when parsing then defaults to visible', async () => {
    const stepsWithAssert = [
      { order: 1, action: 'assert', selector: '.hero', assertType: 'bad_type', description: 'Assert hero' },
    ];
    mockAIClient.chat.mockResolvedValue(JSON.stringify({ steps: stepsWithAssert }));

    const plan = await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID);

    expect(plan.steps[0].assertType).toBe('visible');
  });

  it('given forceFresh=true when cached plan exists then ignores cache and calls AI', async () => {
    vi.mocked(getCachedPlan).mockResolvedValue(cachedPlan as never);

    const plan = await planTest(baseTestCase, mockAIClient as never, MOCK_TAB_ID, true);

    expect(mockAIClient.chat).toHaveBeenCalledOnce();
    expect(plan.steps).toHaveLength(5);
  });
});
