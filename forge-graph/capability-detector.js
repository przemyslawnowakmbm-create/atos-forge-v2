#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Built-in Capability Definitions
// ============================================================
// Each capability has:
//   - signals: strings to match inside file content (fast indexOf)
//   - filePatterns: regex to match against file paths
//   - importPatterns: regex to match against import strings
//   - symbolPatterns: regex to match against symbol names
//   - agent_context: domain guidance for agents working in this area
//   - weight: inherent reliability of this capability signal (0-1)

const CAPABILITY_DEFINITIONS = {
  jwt: {
    signals: ['jsonwebtoken', 'jose', 'jwt.sign', 'jwt.verify', 'Bearer ', 'JwtPayload', "token.split('.')"],
    filePatterns: [/jwt/i, /token/i],
    importPatterns: [/jsonwebtoken/i, /jose/i, /jwt/i],
    symbolPatterns: [/verifyToken/i, /signToken/i, /JwtPayload/i, /decodeToken/i],
    agent_context: "JWT authentication specialist. Use jose (not jsonwebtoken — CommonJS issues). Always validate expiry. Never store tokens in localStorage for sensitive apps.",
    weight: 0.9,
  },
  oauth2: {
    signals: ['oauth', 'authorization_code', 'client_credentials', 'redirect_uri', 'PKCE', 'code_verifier'],
    filePatterns: [/oauth/i, /authorize/i],
    importPatterns: [/oauth/i, /passport-oauth/i, /openid-client/i, /oidc/i],
    symbolPatterns: [/authorizeUrl/i, /codeVerifier/i, /exchangeCode/i, /refreshToken/i],
    agent_context: "OAuth 2.0 specialist. Implement PKCE for public clients. Validate state parameter. Handle token refresh gracefully.",
    weight: 0.9,
  },
  stripe: {
    signals: ['stripe', 'payment_intent', 'PaymentIntent', 'subscription', 'webhook_secret', 'Stripe('],
    filePatterns: [/stripe/i, /payment/i, /billing/i, /checkout/i],
    importPatterns: [/stripe/i],
    symbolPatterns: [/createPaymentIntent/i, /handleWebhook/i, /createSubscription/i],
    agent_context: "Stripe integration specialist. Always use idempotency keys. Verify webhook signatures. Use PaymentIntents API. Never log card numbers.",
    weight: 0.95,
  },
  database_sql: {
    signals: ['SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'CREATE TABLE', 'ALTER TABLE', 'knex(', 'sequelize', 'typeorm', 'prisma'],
    filePatterns: [/model/i, /schema/i, /migration/i, /entity/i, /repository/i, /dao/i, /prisma/i, /drizzle/i],
    importPatterns: [/prisma/i, /typeorm/i, /sequelize/i, /knex/i, /drizzle/i, /better-sqlite3/i, /pg\b/i, /mysql/i, /neo4j/i, /mongoose/i],
    symbolPatterns: [/createTable/i, /migrate/i, /findById/i, /repository/i, /getConnection/i, /runQuery/i],
    agent_context: "Database specialist. Write reversible migrations. Add indexes for foreign keys. Consider query performance. Use transactions for multi-table operations.",
    weight: 0.85,
  },
  react_advanced: {
    signals: ['useMemo', 'useCallback', 'React.memo', 'React.lazy', 'Suspense', 'ErrorBoundary', 'forwardRef', 'useImperativeHandle'],
    filePatterns: [/\.tsx$/, /\.jsx$/, /component/i],
    importPatterns: [/react/i],
    symbolPatterns: [/useMemo/i, /useCallback/i, /ErrorBoundary/i, /forwardRef/i, /Suspense/i],
    agent_context: "Advanced React specialist. Optimize re-renders. Use proper memo boundaries. Handle loading states with Suspense. Implement error boundaries.",
    weight: 0.85,
  },
  kubernetes: {
    signals: ['apiVersion:', 'kind: Deployment', 'kind: Service', 'helm', 'kubectl', 'spec:', 'containers:', 'replicas:'],
    filePatterns: [/k8s/i, /kubernetes/i, /helm/i, /\.ya?ml$/i],
    importPatterns: [/@kubernetes\/client-node/i],
    symbolPatterns: [/deployment/i, /kubectl/i],
    agent_context: "Kubernetes specialist. Follow 12-factor app principles. Set resource limits. Use health checks. Configure proper RBAC.",
    weight: 0.85,
  },
  graphql: {
    signals: ['typeDefs', 'resolvers', 'gql`', 'ApolloServer', 'schema.graphql', 'Query {', 'Mutation {', 'useQuery', 'useMutation'],
    filePatterns: [/graphql/i, /resolver/i, /schema\.graphql/i],
    importPatterns: [/graphql/i, /apollo/i, /@graphql/i, /type-graphql/i, /nexus/i, /pothos/i],
    symbolPatterns: [/resolver/i, /typeDefs/i, /useQuery/i, /useMutation/i],
    agent_context: "GraphQL specialist. Design schema-first. Implement proper pagination (cursor-based). Handle N+1 with dataloaders. Validate input types.",
    weight: 0.9,
  },
  websockets: {
    signals: ['socket.io', 'ws://', 'wss://', 'WebSocket', 'onmessage', 'onclose', 'socket.emit', 'socket.on'],
    filePatterns: [/socket/i, /ws/i, /realtime/i, /live/i],
    importPatterns: [/socket\.io/i, /ws\b/i, /pusher/i, /ably/i],
    symbolPatterns: [/onConnect/i, /onMessage/i, /broadcast/i, /socketEmit/i],
    agent_context: "WebSocket specialist. Handle reconnection. Implement heartbeat. Consider scaling with Redis adapter. Handle backpressure.",
    weight: 0.8,
  },
  testing: {
    signals: ['describe(', 'it(', 'test(', 'expect(', 'jest', 'vitest', 'mocha', 'pytest', 'beforeEach', 'afterEach', 'mock', 'spy'],
    filePatterns: [/\.test\./i, /\.spec\./i, /\.e2e\./i, /__tests__/i, /test\//i, /tests\//i],
    importPatterns: [/jest/i, /vitest/i, /mocha/i, /chai/i, /supertest/i, /playwright/i, /cypress/i, /pytest/i],
    symbolPatterns: [/describe/i, /expect/i, /beforeEach/i, /afterEach/i],
    agent_context: "Testing specialist. Write isolated unit tests. Mock external dependencies. Use factories for test data. Aim for behavior testing over implementation testing.",
    weight: 0.95,
  },
  docker: {
    signals: ['Dockerfile', 'docker-compose', 'ENTRYPOINT', 'FROM ', 'COPY ', 'RUN ', 'EXPOSE'],
    filePatterns: [/Dockerfile/i, /docker-compose/i, /\.dockerignore/i],
    importPatterns: [],
    symbolPatterns: [],
    agent_context: "Docker specialist. Use multi-stage builds. Minimize layer count. Don't run as root. Use .dockerignore. Pin base image versions.",
    weight: 0.85,
  },
  ci_cd: {
    signals: ['.github/workflows', 'gitlab-ci', 'Jenkinsfile', 'pipeline:', 'steps:', 'jobs:', 'stage:'],
    filePatterns: [/\.github\/workflows/i, /gitlab-ci/i, /Jenkinsfile/i, /\.circleci/i, /bitbucket-pipelines/i],
    importPatterns: [],
    symbolPatterns: [],
    agent_context: "CI/CD specialist. Cache dependencies. Parallelize independent jobs. Fail fast. Use matrix strategies for multi-platform testing.",
    weight: 0.8,
  },
  message_queue: {
    signals: ['amqplib', 'bullmq', 'kafka', 'SQS', 'pubsub', 'NATS', 'RabbitMQ', 'queue.add', 'consumer'],
    filePatterns: [/queue/i, /worker/i, /consumer/i, /producer/i, /pubsub/i],
    importPatterns: [/bull/i, /bullmq/i, /rabbitmq/i, /amqplib/i, /kafkajs/i, /nats/i, /celery/i, /sqs/i],
    symbolPatterns: [/publish/i, /subscribe/i, /enqueue/i, /processJob/i],
    agent_context: "Message queue specialist. Ensure idempotent consumers. Implement dead letter queues. Handle message ordering where needed. Monitor queue depth.",
    weight: 0.8,
  },
  caching: {
    signals: ['redis', 'memcached', 'cache.get', 'cache.set', 'TTL', 'invalidate', 'cache-control'],
    filePatterns: [/cache/i, /redis/i, /memcache/i],
    importPatterns: [/redis/i, /ioredis/i, /memcached/i, /lru-cache/i, /node-cache/i],
    symbolPatterns: [/getCache/i, /setCache/i, /invalidateCache/i],
    agent_context: "Caching specialist. Design cache invalidation strategy. Set appropriate TTLs. Use cache-aside pattern. Handle thundering herd.",
    weight: 0.8,
  },
  security: {
    signals: ['bcrypt', 'argon2', 'crypto', 'helmet', 'cors', 'csrf', 'XSS', 'sanitize', 'escape', 'Content-Security-Policy'],
    filePatterns: [/security/i, /sanitize/i, /crypto/i, /helmet/i],
    importPatterns: [/bcrypt/i, /argon2/i, /helmet/i, /csurf/i, /hpp/i, /express-rate-limit/i, /xss/i],
    symbolPatterns: [/hashPassword/i, /sanitize/i, /validateInput/i, /rateLimit/i],
    agent_context: "Security specialist. Hash passwords with argon2/bcrypt. Validate and sanitize all input. Set security headers. Prevent injection attacks.",
    weight: 0.9,
  },
  file_processing: {
    signals: ['multer', 'formidable', 'fs.createReadStream', 'csv-parse', 'xlsx', 'pdf', 'sharp', 'imagemagick'],
    filePatterns: [/upload/i, /storage/i, /media/i, /file-process/i],
    importPatterns: [/multer/i, /formidable/i, /csv-parse/i, /xlsx/i, /sharp/i, /jimp/i, /pdf-parse/i],
    symbolPatterns: [/uploadFile/i, /processFile/i, /parseCSV/i, /resizeImage/i],
    agent_context: "File processing specialist. Validate file types server-side. Stream large files. Handle encoding issues. Implement virus scanning for uploads.",
    weight: 0.8,
  },
  // --- Additional built-in capabilities (from original detector) ---
  authentication: {
    signals: ['passport', 'next-auth', 'auth0', 'keycloak', 'session', 'login', 'logout', 'authenticate'],
    filePatterns: [/auth/i, /login/i, /signup/i, /session/i, /passport/i, /keycloak/i],
    importPatterns: [/passport/i, /next-auth/i, /auth0/i, /keycloak/i, /lucia/i],
    symbolPatterns: [/authenticate/i, /login/i, /logout/i, /hashPassword/i],
    agent_context: "Authentication specialist. Use established libraries (passport, lucia, next-auth). Hash passwords properly. Implement rate limiting on auth endpoints. Use secure session configuration.",
    weight: 0.9,
  },
  api_server: {
    signals: ['app.get(', 'app.post(', 'app.use(', 'router.get(', '@Controller', '@Get(', '@Post(', '@ApiOperation', 'FastAPI', '@app.route'],
    filePatterns: [/route/i, /controller/i, /endpoint/i, /handler/i, /middleware/i],
    importPatterns: [/express/i, /fastify/i, /koa/i, /hapi/i, /nestjs/i, /@nestjs/i, /trpc/i, /fastapi/i, /flask/i, /django/i, /gin/i],
    symbolPatterns: [/router/i, /handleRequest/i, /controller/i, /middleware/i],
    agent_context: "API server specialist. Use proper HTTP status codes. Validate request bodies. Implement rate limiting. Return consistent error formats. Document endpoints.",
    weight: 0.9,
  },
  ui_components: {
    signals: ['useState', 'useEffect', 'createComponent', 'template:', '<template>', 'render()', 'jsx', 'tsx'],
    filePatterns: [/component/i, /\.tsx$/, /\.jsx$/, /widget/i, /view/i, /page/i],
    importPatterns: [/react/i, /vue/i, /angular/i, /svelte/i, /solid-js/i, /preact/i],
    symbolPatterns: [/render/i, /Component/i, /useState/i, /useEffect/i],
    agent_context: "UI component specialist. Keep components small and focused. Separate logic from presentation. Handle loading and error states. Follow accessibility best practices.",
    weight: 0.85,
  },
  state_management: {
    signals: ['createStore', 'dispatch', 'useSelector', 'createSlice', 'atom(', 'useRecoilState', 'create()', 'defineStore'],
    filePatterns: [/store/i, /reducer/i, /action/i, /slice/i, /context/i, /atom/i],
    importPatterns: [/redux/i, /zustand/i, /recoil/i, /mobx/i, /vuex/i, /pinia/i, /jotai/i, /valtio/i],
    symbolPatterns: [/createStore/i, /dispatch/i, /reducer/i, /useSelector/i, /createSlice/i],
    agent_context: "State management specialist. Keep state normalized. Derive computed values. Use selectors for performance. Avoid unnecessary global state.",
    weight: 0.8,
  },
  email: {
    signals: ['nodemailer', 'sendgrid', 'SES', 'mailgun', 'postmark', 'sendEmail', 'smtp'],
    filePatterns: [/email/i, /mailer/i, /notification/i, /smtp/i],
    importPatterns: [/nodemailer/i, /sendgrid/i, /@aws-sdk.*ses/i, /mailgun/i, /postmark/i, /resend/i],
    symbolPatterns: [/sendEmail/i, /sendMail/i, /emailTemplate/i],
    agent_context: "Email specialist. Use templates for emails. Implement retry with backoff. Validate email addresses. Handle bounces and complaints. Use bulk send APIs for volume.",
    weight: 0.85,
  },
  scheduling: {
    signals: ['cron', 'schedule', 'setInterval', 'recurring', 'agenda', 'crontab'],
    filePatterns: [/cron/i, /scheduler/i, /job/i],
    importPatterns: [/node-cron/i, /agenda/i, /bull/i, /celery/i, /crontab/i],
    symbolPatterns: [/schedule/i, /cronJob/i, /runAt/i, /recurring/i],
    agent_context: "Scheduling specialist. Use distributed locks for clustered environments. Implement idempotent job handlers. Monitor job execution times. Handle timezone correctly.",
    weight: 0.75,
  },
  search: {
    signals: ['elasticsearch', 'algolia', 'meilisearch', 'typesense', 'lunr', 'fullTextSearch', 'searchIndex'],
    filePatterns: [/search/i, /elastic/i],
    importPatterns: [/elasticsearch/i, /algolia/i, /meilisearch/i, /typesense/i, /lunr/i],
    symbolPatterns: [/searchIndex/i, /fullTextSearch/i, /reindex/i],
    agent_context: "Search specialist. Design index mapping carefully. Implement faceted search where needed. Handle relevance tuning. Use bulk indexing for performance.",
    weight: 0.8,
  },
  ai_ml: {
    signals: ['openai', 'anthropic', 'langchain', 'embedding', 'vector', 'chatCompletion', 'inference', 'llm'],
    filePatterns: [/ai/i, /ml/i, /inference/i, /llm/i, /embedding/i, /vector/i],
    importPatterns: [/openai/i, /anthropic/i, /langchain/i, /tensorflow/i, /torch/i, /transformers/i, /pinecone/i, /chromadb/i],
    symbolPatterns: [/predict/i, /inference/i, /embed/i, /generateCompletion/i, /chatCompletion/i],
    agent_context: "AI/ML specialist. Handle rate limits and retries. Stream responses for LLMs. Cache embeddings. Validate model outputs. Monitor token usage and costs.",
    weight: 0.85,
  },
  logging: {
    signals: ['winston', 'pino', 'bunyan', 'morgan', 'sentry', 'opentelemetry', 'datadog', 'logger.info', 'logger.error'],
    filePatterns: [/logger/i, /logging/i, /telemetry/i, /observability/i],
    importPatterns: [/winston/i, /pino/i, /bunyan/i, /morgan/i, /datadog/i, /sentry/i, /opentelemetry/i],
    symbolPatterns: [/logger/i, /logError/i, /captureException/i],
    agent_context: "Logging/observability specialist. Use structured logging. Include correlation IDs. Set appropriate log levels. Don't log sensitive data. Use sampling for high-volume traces.",
    weight: 0.7,
  },
  authorization: {
    signals: ['casl', 'casbin', 'accesscontrol', 'permission', 'rbac', 'policy', 'guard', 'can(', 'ability'],
    filePatterns: [/permission/i, /rbac/i, /acl/i, /policy/i, /guard/i, /role/i],
    importPatterns: [/casl/i, /casbin/i, /accesscontrol/i],
    symbolPatterns: [/canAccess/i, /checkPermission/i, /hasRole/i, /authorize/i, /guard/i],
    agent_context: "Authorization specialist. Implement principle of least privilege. Use attribute-based access control for complex policies. Centralize authorization logic. Test edge cases in permission rules.",
    weight: 0.85,
  },
  graph_visualization: {
    signals: ['cytoscape', 'd3.select', 'chart.js', 'recharts', 'plotly', 'vis-network', 'SVG', 'canvas'],
    filePatterns: [/graph/i, /cytoscape/i, /d3/i, /chart/i, /visualization/i],
    importPatterns: [/cytoscape/i, /d3/i, /chart\.js/i, /recharts/i, /plotly/i, /vis-network/i],
    symbolPatterns: [/renderGraph/i, /drawChart/i, /createVisualization/i],
    agent_context: "Graph/visualization specialist. Optimize rendering for large datasets. Use virtual scrolling. Implement zoom and pan. Handle layout algorithms efficiently.",
    weight: 0.8,
  },
};

// ============================================================
// Signal Scanner
// ============================================================

/**
 * Scan file content for signal strings.
 * Uses indexOf for speed — no regex compilation per file.
 * @param {string} content - File content
 * @param {string[]} signals - Signal strings to search for
 * @returns {string[]} Matched signals
 */
function scanContentSignals(content, signals) {
  const matches = [];
  for (const signal of signals) {
    if (content.indexOf(signal) !== -1) {
      matches.push(signal);
    }
  }
  return matches;
}

/**
 * Compute signal uniqueness weight.
 * Signals that appear in fewer capabilities are more discriminating.
 * @param {string} signal - The signal string
 * @param {string} capName - The capability it belongs to
 * @returns {number} Weight multiplier (1.0 = common, up to 2.0 = highly unique)
 */
function getSignalUniqueness(signal, capName) {
  const signalLower = signal.toLowerCase();
  let appearsIn = 0;
  for (const [name, def] of Object.entries(CAPABILITY_DEFINITIONS)) {
    if (name === capName) continue;
    if (def.signals.some(s => s.toLowerCase() === signalLower)) appearsIn++;
  }
  // 0 other caps = 2.0x, 1 other = 1.5x, 2+ others = 1.0x
  if (appearsIn === 0) return 2.0;
  if (appearsIn === 1) return 1.5;
  return 1.0;
}

// Pre-compute uniqueness weights at module load
const _signalWeights = {};
for (const [capName, def] of Object.entries(CAPABILITY_DEFINITIONS)) {
  _signalWeights[capName] = {};
  for (const signal of def.signals) {
    _signalWeights[capName][signal] = getSignalUniqueness(signal, capName);
  }
}

// ============================================================
// Custom Capability Loader
// ============================================================

/**
 * Load user-defined capabilities from .forge/capabilities/custom.yaml.
 * Format (simple YAML subset — no dependency on yaml parser):
 *   capability_name:
 *     signals:
 *       - "pattern1"
 *       - "pattern2"
 *     agent_context: "description"
 *     weight: 0.9
 *
 * @param {string} repoRoot
 * @returns {Object} map of capName -> definition
 */
function loadCustomCapabilities(repoRoot) {
  const customPath = path.join(repoRoot, '.forge', 'capabilities', 'custom.yaml');
  if (!fs.existsSync(customPath)) return {};

  const raw = fs.readFileSync(customPath, 'utf8');
  return parseSimpleYaml(raw);
}

/**
 * Minimal YAML parser for capability definitions.
 * Handles the specific subset we need: top-level keys, signals array, strings.
 */
function parseSimpleYaml(raw) {
  const result = {};
  let currentCap = null;
  let currentKey = null;
  let inArray = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    // Top-level capability name (no indent, ends with colon)
    if (indent === 0 && trimmed.endsWith(':') && !trimmed.startsWith('-')) {
      currentCap = trimmed.slice(0, -1).trim();
      result[currentCap] = { signals: [], filePatterns: [], importPatterns: [], symbolPatterns: [], agent_context: '', weight: 0.8 };
      currentKey = null;
      inArray = false;
      continue;
    }

    if (!currentCap) continue;

    // Key under a capability
    if (indent > 0 && trimmed.endsWith(':') && !trimmed.includes('- ')) {
      currentKey = trimmed.slice(0, -1).trim();
      inArray = currentKey === 'signals';
      continue;
    }

    // Inline key: value
    const kvMatch = trimmed.match(/^\s+(\w+):\s*(.+)$/);
    if (kvMatch && !kvMatch[2].startsWith('-')) {
      const key = kvMatch[1];
      let val = kvMatch[2].replace(/^["']|["']$/g, '');
      if (key === 'weight') val = parseFloat(val);
      if (key === 'agent_context') result[currentCap].agent_context = val;
      else if (key === 'weight') result[currentCap].weight = val;
      continue;
    }

    // Array item
    const arrayMatch = trimmed.match(/^\s+-\s*["']?(.+?)["']?\s*$/);
    if (arrayMatch && currentKey) {
      const val = arrayMatch[1];
      if (currentKey === 'signals') {
        result[currentCap].signals.push(val);
      } else if (currentKey === 'filePatterns') {
        try { result[currentCap].filePatterns.push(new RegExp(val, 'i')); } catch { /* skip bad regex */ }
      } else if (currentKey === 'importPatterns') {
        try { result[currentCap].importPatterns.push(new RegExp(val, 'i')); } catch { /* skip bad regex */ }
      } else if (currentKey === 'symbolPatterns') {
        try { result[currentCap].symbolPatterns.push(new RegExp(val, 'i')); } catch { /* skip bad regex */ }
      }
    }
  }

  return result;
}

// ============================================================
// Core Detection
// ============================================================

/**
 * Get merged capability definitions (built-in + custom overrides).
 * Custom definitions override built-in ones with the same name.
 * @param {string} [repoRoot]
 * @returns {Object}
 */
function getCapabilityDefinitions(repoRoot) {
  const defs = { ...CAPABILITY_DEFINITIONS };
  if (repoRoot) {
    const custom = loadCustomCapabilities(repoRoot);
    for (const [name, def] of Object.entries(custom)) {
      defs[name] = def;
    }
  }
  return defs;
}

/**
 * Detect capabilities for a given module.
 *
 * Backward-compatible with builder.js and updater.js call signature:
 *   detectCapabilities(moduleName, filePaths, symbols, imports)
 *
 * Enhanced: also accepts options object as 5th parameter for content scanning:
 *   detectCapabilities(moduleName, filePaths, symbols, imports, { repoRoot, fileContents })
 *
 * @param {string} moduleName
 * @param {string[]} filePaths - Files in this module (relative to repo root).
 * @param {Array<{file: string, name: string}>} symbols - Exported symbols in this module.
 * @param {Array<{source_file: string, import_name: string}>} imports - Imports in this module.
 * @param {{ repoRoot?: string, fileContents?: Map<string, string> }} [opts]
 * @returns {Array<{capability: string, confidence: number, evidence: string, agent_context?: string}>}
 */
function detectCapabilities(moduleName, filePaths, symbols, imports, opts = {}) {
  const results = [];
  const defs = getCapabilityDefinitions(opts.repoRoot);

  // If repoRoot is provided but no fileContents, we can read files for signal scanning
  const fileContents = opts.fileContents || null;
  const repoRoot = opts.repoRoot || null;

  // Merge all file contents for content-level scanning
  let allContent = null;
  if (fileContents) {
    const chunks = [];
    for (const fp of filePaths) {
      const c = fileContents.get(fp);
      if (c) chunks.push(c);
    }
    allContent = chunks.join('\n');
  } else if (repoRoot) {
    // Lazy-read files for scanning (capped to avoid memory issues)
    const chunks = [];
    let totalSize = 0;
    const MAX_SCAN_SIZE = 10 * 1024 * 1024; // 10MB cap
    for (const fp of filePaths) {
      if (totalSize > MAX_SCAN_SIZE) break;
      try {
        const content = fs.readFileSync(path.join(repoRoot, fp), 'utf8');
        chunks.push(content);
        totalSize += content.length;
      } catch { /* skip unreadable files */ }
    }
    allContent = chunks.join('\n');
  }

  for (const [capName, def] of Object.entries(defs)) {
    let score = 0;
    let maxScore = 0;
    const evidence = [];

    // --- Content signal scanning (highest value) ---
    if (allContent && def.signals && def.signals.length > 0) {
      const signalMatches = scanContentSignals(allContent, def.signals);
      if (signalMatches.length > 0) {
        // Weight by signal uniqueness
        let weightedCount = 0;
        for (const m of signalMatches) {
          const w = (_signalWeights[capName] && _signalWeights[capName][m]) || 1.0;
          weightedCount += w;
        }
        const signalScore = Math.min(weightedCount / def.signals.length, 1.0) * 4;
        score += signalScore;
        evidence.push(`content signals: ${signalMatches.slice(0, 3).join(', ')}${signalMatches.length > 3 ? ` (+${signalMatches.length - 3})` : ''}`);
      }
      maxScore += 4;
    }

    // --- File path pattern matching ---
    if (def.filePatterns && def.filePatterns.length > 0) {
      const fileMatches = filePaths.filter(fp =>
        def.filePatterns.some(p => p.test(fp))
      );
      if (fileMatches.length > 0) {
        const fileScore = Math.min(fileMatches.length / Math.max(filePaths.length, 1), 1) * 3;
        score += fileScore;
        evidence.push(`${fileMatches.length} file(s) match`);
      }
      maxScore += 3;
    }

    // --- Import pattern matching ---
    if (def.importPatterns && def.importPatterns.length > 0) {
      const importMatches = imports.filter(imp =>
        def.importPatterns.some(p => p.test(imp.import_name))
      );
      if (importMatches.length > 0) {
        const importScore = Math.min(importMatches.length, 5) * 0.6;
        score += importScore;
        const uniq = [...new Set(importMatches.map(i => i.import_name))].slice(0, 3);
        evidence.push(`imports: ${uniq.join(', ')}`);
      }
      maxScore += 3;
    }

    // --- Symbol name matching ---
    if (def.symbolPatterns && def.symbolPatterns.length > 0) {
      const symbolMatches = symbols.filter(sym =>
        def.symbolPatterns.some(p => p.test(sym.name))
      );
      if (symbolMatches.length > 0) {
        const symScore = Math.min(symbolMatches.length, 5) * 0.4;
        score += symScore;
        const uniq = [...new Set(symbolMatches.map(s => s.name))].slice(0, 3);
        evidence.push(`symbols: ${uniq.join(', ')}`);
      }
      maxScore += 2;
    }

    // Calculate confidence, weighted by the capability's inherent weight
    const rawConfidence = maxScore > 0 ? score / maxScore : 0;
    const confidence = rawConfidence * (def.weight || 0.8);

    if (confidence >= 0.10) {
      results.push({
        capability: capName,
        confidence: Math.round(confidence * 100) / 100,
        evidence: evidence.join('; '),
        agent_context: def.agent_context || null,
      });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// ============================================================
// YAML Template Writer
// ============================================================

/**
 * Write YAML capability templates to .forge/capabilities/.
 * One file per detected capability with agent_context for reference.
 * @param {string} repoRoot
 * @param {Map<string, Array>} moduleCapabilities - module -> detected caps
 */
function writeCapabilityTemplates(repoRoot, moduleCapabilities) {
  const capDir = path.join(repoRoot, '.forge', 'capabilities');
  if (!fs.existsSync(capDir)) {
    fs.mkdirSync(capDir, { recursive: true });
  }

  // Build aggregate: capability -> { modules, max_confidence, agent_context }
  const aggregate = {};
  for (const [modName, caps] of moduleCapabilities) {
    for (const cap of caps) {
      if (!aggregate[cap.capability]) {
        aggregate[cap.capability] = {
          modules: [],
          max_confidence: 0,
          agent_context: cap.agent_context || '',
        };
      }
      aggregate[cap.capability].modules.push({ module: modName, confidence: cap.confidence });
      if (cap.confidence > aggregate[cap.capability].max_confidence) {
        aggregate[cap.capability].max_confidence = cap.confidence;
      }
    }
  }

  // Write detected.yaml — summary of all detected capabilities
  const detectedLines = [
    '# Forge Detected Capabilities',
    '# Auto-generated by capability-detector. Do not edit.',
    `# Generated: ${new Date().toISOString()}`,
    '#',
    '# To add custom capabilities, create custom.yaml in this directory.',
    '',
  ];

  for (const [capName, info] of Object.entries(aggregate).sort((a, b) => b[1].max_confidence - a[1].max_confidence)) {
    detectedLines.push(`${capName}:`);
    detectedLines.push(`  max_confidence: ${info.max_confidence}`);
    detectedLines.push(`  agent_context: "${escapeYamlString(info.agent_context)}"`);
    detectedLines.push(`  modules:`);
    for (const m of info.modules.sort((a, b) => b.confidence - a.confidence)) {
      detectedLines.push(`    - module: "${m.module}"`);
      detectedLines.push(`      confidence: ${m.confidence}`);
    }
    detectedLines.push('');
  }

  fs.writeFileSync(path.join(capDir, 'detected.yaml'), detectedLines.join('\n'), 'utf8');

  // Write custom.yaml template if it doesn't exist
  const customPath = path.join(capDir, 'custom.yaml');
  if (!fs.existsSync(customPath)) {
    const templateLines = [
      '# Custom capability definitions for this project.',
      '# These override built-in capabilities with the same name.',
      '# Uncomment and modify the example below:',
      '',
      '# my_custom_capability:',
      '#   signals:',
      '#     - "myUniqueSignal"',
      '#     - "anotherSignal"',
      '#   agent_context: "Specialist context for agents working in this area."',
      '#   weight: 0.9',
      '#   filePatterns:',
      '#     - "my-feature"',
      '#   importPatterns:',
      '#     - "my-library"',
      '#   symbolPatterns:',
      '#     - "myFunction"',
      '',
    ];
    fs.writeFileSync(customPath, templateLines.join('\n'), 'utf8');
  }

  return Object.keys(aggregate).length;
}

function escapeYamlString(str) {
  if (!str) return '';
  return str.replace(/"/g, '\\"');
}

// ============================================================
// Full Detect (for CLI — scans entire repo)
// ============================================================

/**
 * Run detection across a repo, optionally using the graph DB for module/file data.
 * @param {string} repoRoot
 * @param {{ db?: string, writeTemplates?: boolean }} opts
 */
function detectAll(repoRoot, opts = {}) {
  const dbPath = opts.db || path.join(repoRoot, '.forge', 'graph.db');
  let modules;
  let filesByModule;
  let symbolsByModule;
  let importsByModule;

  if (fs.existsSync(dbPath)) {
    // Use graph DB for module structure
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');

    modules = db.prepare('SELECT name FROM modules').all().map(r => r.name);
    filesByModule = {};
    symbolsByModule = {};
    importsByModule = {};

    for (const modName of modules) {
      filesByModule[modName] = db.prepare('SELECT path FROM files WHERE module = ?').all(modName).map(r => r.path);
      symbolsByModule[modName] = db.prepare('SELECT name, file FROM symbols WHERE file IN (SELECT path FROM files WHERE module = ?) AND exported = 1').all(modName);
      importsByModule[modName] = db.prepare('SELECT source_file, import_name FROM dependencies WHERE source_file IN (SELECT path FROM files WHERE module = ?)').all(modName);
    }
    db.close();
  } else {
    // No DB — scan everything as a single module
    modules = ['<root>'];
    const { discoverFiles } = require('./builder');
    const allFiles = discoverFiles(repoRoot);
    filesByModule = { '<root>': allFiles };
    symbolsByModule = { '<root>': [] };
    importsByModule = { '<root>': [] };
  }

  const allResults = new Map();
  for (const modName of modules) {
    const caps = detectCapabilities(
      modName,
      filesByModule[modName] || [],
      symbolsByModule[modName] || [],
      importsByModule[modName] || [],
      { repoRoot }
    );
    allResults.set(modName, caps);
  }

  if (opts.writeTemplates !== false) {
    const count = writeCapabilityTemplates(repoRoot, allResults);
    console.log(`  Wrote ${count} capability template(s) to .forge/capabilities/`);
  }

  return allResults;
}

// ============================================================
// CLI Interface
// ============================================================

function printHelp() {
  console.log(`
  Forge Capability Detector

  Usage: node capability-detector.js <command> [options]

  Commands:
    detect                     Scan repo and detect capabilities per module
    list-capabilities          List all built-in + custom capability definitions
    explain <module>           Show detected capabilities with agent context

  Options:
    --root <path>    Repository root (default: cwd)
    --db <path>      Graph database path (default: .forge/graph.db)
    --json           Output as JSON
    --no-write       Skip writing YAML templates
    --help           Show this help
`);
}

function run() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const jsonMode = args.includes('--json');
  const noWrite = args.includes('--no-write');

  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : defaultVal;
  };

  const repoRoot = path.resolve(getArg('--root', process.cwd()));
  const dbPath = getArg('--db', path.join(repoRoot, '.forge', 'graph.db'));

  switch (command) {
    case 'detect': {
      if (!jsonMode) {
        console.log(`\n  Forge Capability Detector`);
        console.log(`  Repository: ${repoRoot}\n`);
      }

      const results = detectAll(repoRoot, { db: dbPath, writeTemplates: !noWrite && !jsonMode });

      if (jsonMode) {
        const obj = {};
        for (const [mod, caps] of results) { obj[mod] = caps; }
        console.log(JSON.stringify(obj, null, 2));
      } else {
        for (const [modName, caps] of results) {
          console.log(`\n  Module: ${modName}`);
          if (caps.length === 0) {
            console.log('    (no capabilities detected)');
            continue;
          }
          for (const cap of caps) {
            const bar = '\u2588'.repeat(Math.round(cap.confidence * 20)).padEnd(20, '\u2591');
            console.log(`    ${cap.capability.padEnd(22)} ${bar} ${(cap.confidence * 100).toFixed(0).padStart(3)}%  ${cap.evidence}`);
          }
        }
        console.log('');
      }
      break;
    }

    case 'list-capabilities': {
      const defs = getCapabilityDefinitions(repoRoot);

      if (jsonMode) {
        const obj = {};
        for (const [name, def] of Object.entries(defs)) {
          obj[name] = {
            signals: def.signals,
            agent_context: def.agent_context,
            weight: def.weight,
            signal_count: def.signals.length,
            pattern_count: (def.filePatterns || []).length + (def.importPatterns || []).length + (def.symbolPatterns || []).length,
          };
        }
        console.log(JSON.stringify(obj, null, 2));
      } else {
        console.log(`\n  Forge — Available Capability Definitions (${Object.keys(defs).length})\n`);
        const sorted = Object.entries(defs).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [name, def] of sorted) {
          const signalCount = def.signals ? def.signals.length : 0;
          const isCustom = !CAPABILITY_DEFINITIONS[name] ? ' [custom]' : '';
          console.log(`  ${name.padEnd(24)} weight=${(def.weight || 0.8).toFixed(2)}  signals=${String(signalCount).padStart(2)}${isCustom}`);
          if (def.agent_context) {
            // Wrap agent_context at 80 chars
            const wrapped = wrapText(def.agent_context, 70);
            for (const line of wrapped) {
              console.log(`    ${line}`);
            }
          }
          console.log('');
        }
      }
      break;
    }

    case 'explain': {
      const modName = args.find((a, i) => i > 0 && !a.startsWith('--') && args[i - 1] !== '--root' && args[i - 1] !== '--db');
      if (!modName) {
        console.error('  Error: module name required');
        console.error('  Usage: node capability-detector.js explain <module>');
        process.exit(1);
      }

      const results = detectAll(repoRoot, { db: dbPath, writeTemplates: false });
      const caps = results.get(modName);

      if (!caps) {
        console.error(`  Error: module not found: ${modName}`);
        const available = [...results.keys()].join(', ');
        console.error(`  Available modules: ${available}`);
        process.exit(1);
      }

      if (jsonMode) {
        console.log(JSON.stringify({ module: modName, capabilities: caps }, null, 2));
      } else {
        console.log(`\n  Capabilities for module: ${modName}\n`);
        if (caps.length === 0) {
          console.log('  No capabilities detected for this module.\n');
          break;
        }

        for (const cap of caps) {
          const bar = '\u2588'.repeat(Math.round(cap.confidence * 20)).padEnd(20, '\u2591');
          console.log(`  \u250c\u2500 ${cap.capability} ${bar} ${(cap.confidence * 100).toFixed(0)}%`);
          console.log(`  \u251c Evidence: ${cap.evidence}`);
          if (cap.agent_context) {
            const wrapped = wrapText(cap.agent_context, 68);
            console.log(`  \u251c Agent Context:`);
            for (const line of wrapped) {
              console.log(`  \u2502   ${line}`);
            }
          }
          console.log(`  \u2514\u2500`);
          console.log('');
        }
      }
      break;
    }

    default:
      console.error(`  Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function wrapText(text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ============================================================
// Entry Point
// ============================================================

if (require.main === module) {
  run();
}

// Backward-compatible exports:
// - detectCapabilities is the primary API, same signature as before (opts is new, optional)
// - CAPABILITY_SIGNATURES kept as alias for builders that import it
const CAPABILITY_SIGNATURES = Object.entries(CAPABILITY_DEFINITIONS).map(([name, def]) => ({
  capability: name,
  filePatterns: def.filePatterns || [],
  importPatterns: def.importPatterns || [],
  symbolPatterns: def.symbolPatterns || [],
  weight: def.weight || 0.8,
}));

module.exports = {
  detectCapabilities,
  detectAll,
  writeCapabilityTemplates,
  getCapabilityDefinitions,
  loadCustomCapabilities,
  scanContentSignals,
  CAPABILITY_DEFINITIONS,
  CAPABILITY_SIGNATURES,
};
