#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Interface Detection Engine
// ============================================================
// Scans a codebase for signals that indicate exported or imported
// interfaces (APIs, events, packages, RPCs, databases).
// Generates a draft .forge/interfaces.yaml for human review.

// ============================================================
// Detection Rule Definitions
// ============================================================

const EXPORT_DETECTORS = [
  {
    name: 'openapi',
    type: 'api',
    protocol: 'rest',
    detect: detectOpenAPI,
    description: 'REST API from OpenAPI/Swagger specs',
  },
  {
    name: 'fastapi',
    type: 'api',
    protocol: 'rest',
    detect: detectFastAPI,
    description: 'REST API from FastAPI route decorators',
  },
  {
    name: 'express',
    type: 'api',
    protocol: 'rest',
    detect: detectExpress,
    description: 'REST API from Express/NestJS route definitions',
  },
  {
    name: 'grpc',
    type: 'rpc',
    protocol: 'grpc',
    detect: detectGRPC,
    description: 'gRPC services from .proto files',
  },
  {
    name: 'kafka_producer',
    type: 'event',
    protocol: 'kafka',
    detect: detectKafkaProducer,
    description: 'Kafka events from producer patterns',
  },
  {
    name: 'rabbitmq_producer',
    type: 'event',
    protocol: 'rabbitmq',
    detect: detectRabbitMQProducer,
    description: 'RabbitMQ events from publish patterns',
  },
  {
    name: 'celery_tasks',
    type: 'event',
    protocol: 'celery',
    detect: detectCeleryTasks,
    description: 'Celery task exports',
  },
  {
    name: 'redis_pubsub',
    type: 'event',
    protocol: 'redis-pubsub',
    detect: detectRedisPubSub,
    description: 'Redis pub/sub channels',
  },
  {
    name: 'npm_package',
    type: 'package',
    protocol: 'npm',
    detect: detectNpmPackage,
    description: 'npm package exports',
  },
  {
    name: 'pypi_package',
    type: 'package',
    protocol: 'pypi',
    detect: detectPyPIPackage,
    description: 'PyPI package exports',
  },
  {
    name: 'database_models',
    type: 'database',
    protocol: null,
    detect: detectDatabaseModels,
    description: 'Database tables from ORM models',
  },
];

const IMPORT_DETECTORS = [
  {
    name: 'env_api_urls',
    type: 'api',
    detect: detectEnvAPIURLs,
    description: 'Consumed services from environment variables',
  },
  {
    name: 'http_clients',
    type: 'api',
    detect: detectHTTPClients,
    description: 'Consumed APIs from HTTP client calls',
  },
  {
    name: 'kafka_consumer',
    type: 'event',
    detect: detectKafkaConsumer,
    description: 'Consumed Kafka topics',
  },
  {
    name: 'celery_caller',
    type: 'event',
    detect: detectCeleryCaller,
    description: 'Consumed Celery tasks',
  },
  {
    name: 'org_packages',
    type: 'package',
    detect: detectOrgPackages,
    description: 'Consumed org-scoped packages',
  },
];

// ============================================================
// Main Detection API
// ============================================================

/**
 * Detect all interfaces in a codebase.
 * @param {string} rootDir - Path to repository root
 * @param {object} opts - Options
 * @param {string} opts.serviceName - Override service name (default: inferred from package.json/directory)
 * @param {string} opts.repo - Override repo identifier (default: inferred from git remote)
 * @param {string} opts.team - Team name
 * @param {string[]} opts.ignorePatterns - Glob patterns to ignore
 * @returns {{ service: object, exports: object[], imports: object[], stats: object }}
 */
function detectInterfaces(rootDir, opts = {}) {
  const root = path.resolve(rootDir);
  const files = collectFiles(root, opts.ignorePatterns);
  const fileContents = new Map(); // lazy cache

  function readFile(filePath) {
    if (!fileContents.has(filePath)) {
      try {
        fileContents.set(filePath, fs.readFileSync(filePath, 'utf8'));
      } catch {
        fileContents.set(filePath, '');
      }
    }
    return fileContents.get(filePath);
  }

  const context = { root, files, readFile };

  // Detect service identity
  const service = detectServiceIdentity(root, opts);

  // Run all export detectors
  const exports = [];
  const exportStats = {};
  for (const detector of EXPORT_DETECTORS) {
    const results = detector.detect(context);
    if (results.length > 0) {
      for (const r of results) {
        exports.push({
          type: detector.type,
          protocol: detector.protocol || r.protocol || null,
          ...r,
          _detector: detector.name,
        });
      }
      exportStats[detector.name] = results.length;
    }
  }

  // Run all import detectors
  const imports = [];
  const importStats = {};
  for (const detector of IMPORT_DETECTORS) {
    const results = detector.detect(context);
    if (results.length > 0) {
      for (const r of results) {
        imports.push({
          type: detector.type,
          ...r,
          _detector: detector.name,
        });
      }
      importStats[detector.name] = results.length;
    }
  }

  return {
    service,
    exports: deduplicateInterfaces(exports),
    imports: deduplicateImports(imports),
    stats: {
      files_scanned: files.length,
      exports_detected: exports.length,
      imports_detected: imports.length,
      detectors: { exports: exportStats, imports: importStats },
    },
  };
}

/**
 * Generate interfaces.yaml content from detection results.
 * @param {object} detection - Result from detectInterfaces()
 * @returns {string} YAML content
 */
function generateYAML(detection) {
  const lines = [];
  lines.push('# AUTO-DETECTED — verify and adjust before committing');
  lines.push(`# Generated by forge-system/detect.js on ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push('service:');
  lines.push(`  name: ${quote(detection.service.name)}`);
  lines.push(`  repo: ${quote(detection.service.repo)}`);
  if (detection.service.team) {
    lines.push(`  team: ${quote(detection.service.team)}`);
  }
  if (detection.service.description) {
    lines.push(`  description: ${quote(detection.service.description)}`);
  }
  if (detection.service.version) {
    lines.push(`  version: ${quote(detection.service.version)}`);
  }
  lines.push('');

  if (detection.exports.length > 0) {
    lines.push('exports:');
    for (const exp of detection.exports) {
      lines.push('');
      lines.push(`  - type: ${exp.type}`);
      if (exp.protocol) lines.push(`    protocol: ${exp.protocol}`);
      if (exp.name) lines.push(`    name: ${quote(exp.name)}`);
      if (exp.description) lines.push(`    description: ${quote(exp.description)}`);
      if (exp.spec_path) lines.push(`    spec: ${exp.spec_path}`);

      // API-specific: endpoints
      if (exp.endpoints && exp.endpoints.length > 0) {
        if (exp.base_path) lines.push(`    base_path: ${exp.base_path}`);
        lines.push('    endpoints:');
        for (const ep of exp.endpoints) {
          lines.push(`      - method: ${ep.method}`);
          lines.push(`        path: ${ep.path}`);
          if (ep.description) lines.push(`        description: ${quote(ep.description)}`);
        }
      }

      // RPC-specific: methods
      if (exp.service_name) lines.push(`    service: ${exp.service_name}`);
      if (exp.methods && exp.methods.length > 0) {
        lines.push(`    methods: [${exp.methods.join(', ')}]`);
      }

      // Event-specific: topic
      if (exp.topic) lines.push(`    topic: ${exp.topic}`);
      if (exp.schema_path) lines.push(`    schema: ${exp.schema_path}`);

      // Package-specific
      if (exp.entry) lines.push(`    entry: ${exp.entry}`);
      if (exp.registry) lines.push(`    registry: ${exp.registry}`);

      // Database-specific
      if (exp.tables && exp.tables.length > 0) {
        lines.push(`    tables: [${exp.tables.join(', ')}]`);
      }
    }
  }

  lines.push('');

  if (detection.imports.length > 0) {
    lines.push('imports:');
    for (const imp of detection.imports) {
      lines.push('');
      lines.push(`  - type: ${imp.type}`);
      if (imp.service) lines.push(`    service: ${quote(imp.service)}`);
      if (imp.name) lines.push(`    name: ${quote(imp.name)}`);
      if (imp.topic) lines.push(`    topic: ${imp.topic}`);
      if (imp.version) lines.push(`    version: ${quote(imp.version)}`);
      if (imp.usage) lines.push(`    usage: ${quote(imp.usage)}`);
      if (imp.endpoints && imp.endpoints.length > 0) {
        lines.push('    endpoints:');
        for (const ep of imp.endpoints) {
          lines.push(`      - method: ${ep.method || 'GET'}`);
          lines.push(`        path: ${ep.path}`);
        }
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write interfaces.yaml to .forge/ directory.
 * @param {string} rootDir - Path to repository root
 * @param {string} yamlContent - YAML content to write
 * @returns {string} Path to written file
 */
function writeInterfacesYAML(rootDir, yamlContent) {
  const forgeDir = path.join(rootDir, '.forge');
  if (!fs.existsSync(forgeDir)) {
    fs.mkdirSync(forgeDir, { recursive: true });
  }
  const filePath = path.join(forgeDir, 'interfaces.yaml');
  fs.writeFileSync(filePath, yamlContent, 'utf8');
  return filePath;
}

// ============================================================
// Service Identity Detection
// ============================================================

function detectServiceIdentity(root, opts) {
  let name = opts.serviceName || null;
  let repo = opts.repo || null;
  let description = null;
  let version = null;

  // Try package.json
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!name) name = pkg.name || null;
      if (!description) description = pkg.description || null;
      if (!version) version = pkg.version || null;
    } catch { /* ignore */ }
  }

  // Try pyproject.toml
  if (!name) {
    const pyprojectPath = path.join(root, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
        if (nameMatch) name = nameMatch[1];
        const versionMatch = content.match(/^version\s*=\s*"([^"]+)"/m);
        if (versionMatch) version = versionMatch[1];
        const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);
        if (descMatch) description = descMatch[1];
      } catch { /* ignore */ }
    }
  }

  // Try setup.py
  if (!name) {
    const setupPath = path.join(root, 'setup.py');
    if (fs.existsSync(setupPath)) {
      try {
        const content = fs.readFileSync(setupPath, 'utf8');
        const nameMatch = content.match(/name\s*=\s*['"]([^'"]+)['"]/);
        if (nameMatch) name = nameMatch[1];
      } catch { /* ignore */ }
    }
  }

  // Try git remote for repo identifier
  if (!repo) {
    try {
      const gitConfigPath = path.join(root, '.git', 'config');
      if (fs.existsSync(gitConfigPath)) {
        const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
        const urlMatch = gitConfig.match(/url\s*=\s*.*[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/m);
        if (urlMatch) repo = urlMatch[1];
      }
    } catch { /* ignore */ }
  }

  // Fallback: directory name
  if (!name) name = path.basename(root);
  if (!repo) repo = name;

  return {
    name: sanitizeName(name),
    repo,
    team: opts.team || null,
    description,
    version,
  };
}

// ============================================================
// Export Detectors
// ============================================================

function detectOpenAPI(ctx) {
  const results = [];
  const specFiles = ctx.files.filter(f =>
    /openapi\.(ya?ml|json)$/i.test(f) ||
    /swagger\.(ya?ml|json)$/i.test(f)
  );

  for (const specFile of specFiles) {
    const content = ctx.readFile(specFile);
    const endpoints = [];
    const relPath = path.relative(ctx.root, specFile);

    // Extract paths from YAML/JSON OpenAPI specs
    const pathMatches = content.matchAll(/^\s{2,4}(\/[^\s:]+):\s*$/gm);
    for (const m of pathMatches) {
      const apiPath = m[1];
      // Find methods under this path
      const methodRegex = new RegExp(`^\\s{4,8}(get|post|put|patch|delete|options|head):\\s*$`, 'gm');
      const pathSection = content.slice(m.index);
      const nextPathIdx = pathSection.indexOf('\n  /', 1);
      const section = nextPathIdx > 0 ? pathSection.slice(0, nextPathIdx) : pathSection.slice(0, 500);
      const methodMatches = section.matchAll(methodRegex);
      for (const mm of methodMatches) {
        endpoints.push({
          method: mm[1].toUpperCase(),
          path: apiPath,
        });
      }
    }

    if (endpoints.length > 0) {
      // Find base path
      const basePathMatch = content.match(/basePath:\s*['"]?([^\s'"]+)/);
      const serverMatch = content.match(/url:\s*['"]?([^\s'"]+)/);
      results.push({
        name: relPath,
        spec_path: relPath,
        base_path: basePathMatch ? basePathMatch[1] : (serverMatch ? serverMatch[1] : null),
        endpoints,
        description: `REST API from ${relPath}`,
      });
    }
  }

  return results;
}

function detectFastAPI(ctx) {
  const results = [];
  const pyFiles = ctx.files.filter(f => f.endsWith('.py'));
  const endpoints = [];

  for (const f of pyFiles) {
    const content = ctx.readFile(f);
    if (!content.includes('FastAPI') && !content.includes('APIRouter') && !content.includes('@app.') && !content.includes('@router.')) continue;

    // Match FastAPI decorators: @app.get("/path"), @router.post("/path")
    const decoratorRegex = /@(?:app|router)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = decoratorRegex.exec(content)) !== null) {
      endpoints.push({
        method: match[1].toUpperCase(),
        path: match[2],
        _source: path.relative(ctx.root, f),
      });
    }
  }

  if (endpoints.length > 0) {
    // Group by base path prefix
    const basePath = findCommonPrefix(endpoints.map(e => e.path));
    results.push({
      name: basePath || '/api',
      base_path: basePath || '/api',
      endpoints,
      description: 'REST API from FastAPI routes',
    });
  }

  return results;
}

function detectExpress(ctx) {
  const results = [];
  const jsFiles = ctx.files.filter(f => /\.(js|ts|mjs|cjs)$/.test(f));
  const endpoints = [];

  for (const f of jsFiles) {
    const content = ctx.readFile(f);

    // Express: router.get('/path', ...), app.post('/path', ...)
    // Skip files that are detectors/configs containing route patterns as string literals
    const relPath = path.relative(ctx.root, f);
    if (/detector|capability|signal|config.*pattern/i.test(relPath)) continue;

    const expressRegex = /(?:router|app)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = expressRegex.exec(content)) !== null) {
      const routePath = match[2];
      // Skip false positives: paths with commas, spaces, or that are clearly signal strings
      if (/[,\s]/.test(routePath) || routePath.length > 200) continue;
      endpoints.push({
        method: match[1].toUpperCase(),
        path: routePath,
        _source: relPath,
      });
    }

    // NestJS: @Get('/path'), @Post('/path'), @Controller('/prefix')
    const nestRegex = /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"]([^'"]*)['"]\s*\)/g;
    while ((match = nestRegex.exec(content)) !== null) {
      // Try to find controller prefix
      const controllerMatch = content.match(/@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)/);
      const prefix = controllerMatch ? controllerMatch[1] : '';
      endpoints.push({
        method: match[1].toUpperCase(),
        path: prefix ? `${prefix}/${match[2]}`.replace(/\/+/g, '/') : match[2] || '/',
        _source: path.relative(ctx.root, f),
      });
    }
  }

  if (endpoints.length > 0) {
    const basePath = findCommonPrefix(endpoints.map(e => e.path));
    results.push({
      name: basePath || '/api',
      base_path: basePath || '/api',
      endpoints,
      description: 'REST API from Express/NestJS routes',
    });
  }

  return results;
}

function detectGRPC(ctx) {
  const results = [];
  const protoFiles = ctx.files.filter(f => f.endsWith('.proto'));

  for (const f of protoFiles) {
    const content = ctx.readFile(f);
    const relPath = path.relative(ctx.root, f);

    // Extract service definitions
    const serviceRegex = /service\s+(\w+)\s*\{([^}]+)\}/gs;
    let svcMatch;
    while ((svcMatch = serviceRegex.exec(content)) !== null) {
      const serviceName = svcMatch[1];
      const body = svcMatch[2];
      const methods = [];

      const rpcRegex = /rpc\s+(\w+)\s*\(/g;
      let rpcMatch;
      while ((rpcMatch = rpcRegex.exec(body)) !== null) {
        methods.push(rpcMatch[1]);
      }

      results.push({
        name: serviceName,
        service_name: serviceName,
        protocol: 'grpc',
        spec_path: relPath,
        methods,
        description: `gRPC service from ${relPath}`,
      });
    }
  }

  return results;
}

function detectKafkaProducer(ctx) {
  const results = [];
  const topics = new Set();

  for (const f of ctx.files) {
    if (!/\.(js|ts|py|java)$/.test(f)) continue;
    const content = ctx.readFile(f);
    if (!content.includes('kafka') && !content.includes('Kafka') && !content.includes('producer') && !content.includes('Producer')) continue;

    // JS/TS: producer.send({ topic: 'name' })
    const jsTopic = /topic:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = jsTopic.exec(content)) !== null) {
      if (content.includes('producer') || content.includes('Producer')) {
        topics.add(match[1]);
      }
    }

    // Python: producer.send('topic_name', ...)
    const pyTopic = /producer\.send\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = pyTopic.exec(content)) !== null) {
      topics.add(match[1]);
    }

    // Java: kafkaTemplate.send("topic_name", ...)
    const javaTopic = /(?:kafkaTemplate|producer)\.send\s*\(\s*"([^"]+)"/g;
    while ((match = javaTopic.exec(content)) !== null) {
      topics.add(match[1]);
    }
  }

  for (const topic of topics) {
    results.push({
      name: topic,
      topic,
      description: `Kafka topic: ${topic}`,
    });
  }

  return results;
}

function detectRabbitMQProducer(ctx) {
  const results = [];
  const exchanges = new Set();

  for (const f of ctx.files) {
    if (!/\.(js|ts|py|java)$/.test(f)) continue;
    const content = ctx.readFile(f);
    if (!content.includes('rabbit') && !content.includes('Rabbit') && !content.includes('amqp') && !content.includes('AMQP')) continue;

    // channel.publish('exchange', 'routing_key', ...)
    const publishRegex = /\.publish\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = publishRegex.exec(content)) !== null) {
      exchanges.add(`${match[1]}/${match[2]}`);
    }

    // channel.sendToQueue('queue_name', ...)
    const queueRegex = /\.sendToQueue\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = queueRegex.exec(content)) !== null) {
      exchanges.add(match[1]);
    }

    // Python pika: channel.basic_publish(exchange='', routing_key='queue')
    const pikaRegex = /basic_publish\s*\([^)]*routing_key\s*=\s*['"]([^'"]+)['"]/g;
    while ((match = pikaRegex.exec(content)) !== null) {
      exchanges.add(match[1]);
    }
  }

  for (const name of exchanges) {
    results.push({
      name,
      topic: name,
      description: `RabbitMQ exchange/queue: ${name}`,
    });
  }

  return results;
}

function detectCeleryTasks(ctx) {
  const results = [];
  const tasks = [];

  for (const f of ctx.files) {
    if (!f.endsWith('.py')) continue;
    const content = ctx.readFile(f);
    if (!content.includes('@') || (!content.includes('task') && !content.includes('shared_task'))) continue;

    // @app.task, @shared_task, @celery.task
    const taskRegex = /@(?:app\.task|shared_task|celery\.task)(?:\s*\([^)]*\))?\s*\ndef\s+(\w+)/g;
    let match;
    while ((match = taskRegex.exec(content)) !== null) {
      tasks.push({
        name: match[1],
        _source: path.relative(ctx.root, f),
      });
    }
  }

  for (const task of tasks) {
    results.push({
      name: task.name,
      topic: task.name,
      description: `Celery task: ${task.name}`,
    });
  }

  return results;
}

function detectRedisPubSub(ctx) {
  const results = [];
  const channels = new Set();

  for (const f of ctx.files) {
    if (!/\.(js|ts|py)$/.test(f)) continue;
    const content = ctx.readFile(f);
    if (!content.includes('redis') && !content.includes('Redis')) continue;

    // JS: redis.publish('channel', msg)
    const publishRegex = /\.publish\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = publishRegex.exec(content)) !== null) {
      channels.add(match[1]);
    }

    // Python: redis.publish('channel', msg)
    // Same pattern works for Python
  }

  for (const channel of channels) {
    results.push({
      name: channel,
      topic: channel,
      protocol: 'redis-pubsub',
      description: `Redis pub/sub channel: ${channel}`,
    });
  }

  return results;
}

function detectNpmPackage(ctx) {
  const results = [];
  const pkgPath = path.join(ctx.root, 'package.json');
  if (!fs.existsSync(pkgPath)) return results;

  try {
    const pkg = JSON.parse(ctx.readFile(pkgPath));
    // Only detect if this is a publishable package (has main/exports and no private:true, or has explicit exports)
    if (pkg.private && !pkg.exports) return results;

    const hasEntry = pkg.main || pkg.module || pkg.exports || pkg.types || pkg.typings;
    if (!hasEntry) return results;

    const entry = pkg.main || pkg.module || (typeof pkg.exports === 'string' ? pkg.exports : null) || 'index.js';

    results.push({
      name: pkg.name,
      registry: 'npm',
      entry,
      description: pkg.description || `npm package: ${pkg.name}`,
    });
  } catch { /* ignore */ }

  return results;
}

function detectPyPIPackage(ctx) {
  const results = [];

  // Check pyproject.toml
  const pyprojectPath = path.join(ctx.root, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    const content = ctx.readFile(pyprojectPath);
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    // Check if it has build system (indicating it's a distributable package)
    if (nameMatch && content.includes('[build-system]')) {
      results.push({
        name: nameMatch[1],
        registry: 'pypi',
        description: `Python package: ${nameMatch[1]}`,
      });
    }
  }

  // Check setup.py
  if (results.length === 0) {
    const setupPath = path.join(ctx.root, 'setup.py');
    if (fs.existsSync(setupPath)) {
      const content = ctx.readFile(setupPath);
      const nameMatch = content.match(/name\s*=\s*['"]([^'"]+)['"]/);
      if (nameMatch) {
        results.push({
          name: nameMatch[1],
          registry: 'pypi',
          description: `Python package: ${nameMatch[1]}`,
        });
      }
    }
  }

  return results;
}

function detectDatabaseModels(ctx) {
  const tables = new Set();
  let dbName = null;

  for (const f of ctx.files) {
    const content = ctx.readFile(f);

    // SQLAlchemy: __tablename__ = 'table_name'
    if (f.endsWith('.py')) {
      const tableRegex = /__tablename__\s*=\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = tableRegex.exec(content)) !== null) {
        tables.add(match[1]);
      }

      // Django: class Meta: db_table = 'name'
      const djangoRegex = /db_table\s*=\s*['"]([^'"]+)['"]/g;
      while ((match = djangoRegex.exec(content)) !== null) {
        tables.add(match[1]);
      }
    }

    // Prisma: model Name { ... }
    if (f.endsWith('.prisma') || path.basename(f) === 'schema.prisma') {
      const modelRegex = /model\s+(\w+)\s*\{/g;
      let match;
      while ((match = modelRegex.exec(content)) !== null) {
        // Convert PascalCase to snake_case for table name
        tables.add(match[1].replace(/([A-Z])/g, (m, c, i) => i > 0 ? `_${c.toLowerCase()}` : c.toLowerCase()));
      }
    }

    // TypeORM: @Entity('table_name') or @Entity()
    if (/\.(ts|js)$/.test(f) && content.includes('@Entity')) {
      const entityRegex = /@Entity\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      let match;
      while ((match = entityRegex.exec(content)) !== null) {
        tables.add(match[1]);
      }
    }

    // SQL migration files: CREATE TABLE
    if (/\.(sql|migration)$/.test(f) || /migration/i.test(f)) {
      const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`]?(\w+)["'`]?\.)?["'`]?(\w+)["'`]?/gi;
      let match;
      while ((match = createRegex.exec(content)) !== null) {
        tables.add(match[2]);
        if (match[1]) dbName = match[1];
      }
    }
  }

  if (tables.size === 0) return [];

  return [{
    name: dbName || 'database',
    tables: [...tables].sort(),
    description: `Database tables owned by this service`,
  }];
}

// ============================================================
// Import Detectors
// ============================================================

function detectEnvAPIURLs(ctx) {
  const results = [];
  const seen = new Set();

  // Scan .env, .env.example, .env.sample
  const envFiles = ctx.files.filter(f => /\.env(\.\w+)?$/.test(path.basename(f)));
  // Also scan docker-compose for environment vars
  const composeFiles = ctx.files.filter(f => /docker-compose/i.test(path.basename(f)));

  const allEnvFiles = [...envFiles, ...composeFiles];

  for (const f of allEnvFiles) {
    const content = ctx.readFile(f);

    // Match *_API_URL, *_SERVICE_URL, *_BASE_URL patterns
    const urlRegex = /(\w+(?:_API_URL|_SERVICE_URL|_BASE_URL|_ENDPOINT|_HOST))\s*[=:]\s*['"]?([^\s'"#]+)/g;
    let match;
    while ((match = urlRegex.exec(content)) !== null) {
      const varName = match[1];
      const url = match[2];
      if (seen.has(varName)) continue;
      seen.add(varName);

      // Try to infer service name from variable name
      const serviceName = varName
        .replace(/_(?:API_URL|SERVICE_URL|BASE_URL|ENDPOINT|HOST)$/, '')
        .toLowerCase()
        .replace(/_/g, '-');

      results.push({
        service: serviceName + '-service',
        name: varName,
        usage: `Consumed via environment variable ${varName}`,
        _url: url,
      });
    }
  }

  return results;
}

function detectHTTPClients(ctx) {
  const results = [];
  const seen = new Set();

  for (const f of ctx.files) {
    if (!/\.(js|ts|py)$/.test(f)) continue;
    const content = ctx.readFile(f);

    // axios/fetch calls to explicit service paths: axios.get('http://user-service/api/...')
    const clientRegex = /(?:axios|fetch|httpClient|http)\.(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi;
    let match;
    while ((match = clientRegex.exec(content)) !== null) {
      const url = match[2];
      // Only capture if it looks like a service URL (contains service name or explicit host)
      if (url.includes('://') || url.startsWith('${')) {
        const key = `${match[1].toUpperCase()} ${url}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            service: inferServiceFromURL(url),
            name: url,
            usage: `HTTP ${match[1].toUpperCase()} call`,
            endpoints: [{ method: match[1].toUpperCase(), path: url }],
          });
        }
      }
    }

    // Python requests: requests.get('http://...')
    const pyRegex = /requests\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
    while ((match = pyRegex.exec(content)) !== null) {
      const url = match[2];
      const key = `${match[1].toUpperCase()} ${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          service: inferServiceFromURL(url),
          name: url,
          usage: `HTTP ${match[1].toUpperCase()} call (Python requests)`,
          endpoints: [{ method: match[1].toUpperCase(), path: url }],
        });
      }
    }
  }

  return results;
}

function detectKafkaConsumer(ctx) {
  const results = [];
  const topics = new Set();

  for (const f of ctx.files) {
    if (!/\.(js|ts|py|java)$/.test(f)) continue;
    const content = ctx.readFile(f);
    if (!content.includes('consumer') && !content.includes('Consumer') && !content.includes('subscribe')) continue;

    // JS: consumer.subscribe({ topic: 'name' })
    const jsRegex = /subscribe\s*\(\s*\{[^}]*topic:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = jsRegex.exec(content)) !== null) {
      topics.add(match[1]);
    }

    // Python: consumer = KafkaConsumer('topic_name')
    const pyRegex = /KafkaConsumer\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = pyRegex.exec(content)) !== null) {
      topics.add(match[1]);
    }
  }

  for (const topic of topics) {
    results.push({
      name: topic,
      topic,
      service: inferServiceFromTopic(topic),
      usage: `Consuming Kafka topic: ${topic}`,
    });
  }

  return results;
}

function detectCeleryCaller(ctx) {
  const results = [];
  const tasks = new Set();

  for (const f of ctx.files) {
    if (!f.endsWith('.py')) continue;
    const content = ctx.readFile(f);

    // task_name.delay(...), task_name.apply_async(...)
    const delayRegex = /(\w+)\.(delay|apply_async)\s*\(/g;
    let match;
    while ((match = delayRegex.exec(content)) !== null) {
      // Exclude common false positives
      if (!['self', 'cls', 'super', 'result', 'response', 'db', 'session'].includes(match[1])) {
        tasks.add(match[1]);
      }
    }

    // celery_app.send_task('task.name', ...)
    const sendRegex = /send_task\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = sendRegex.exec(content)) !== null) {
      tasks.add(match[1]);
    }
  }

  for (const task of tasks) {
    results.push({
      name: task,
      topic: task,
      service: inferServiceFromTask(task),
      usage: `Calling Celery task: ${task}`,
    });
  }

  return results;
}

function detectOrgPackages(ctx) {
  const results = [];
  const orgPrefixes = ['@'];

  // npm: org-scoped packages from package.json dependencies
  const pkgPath = path.join(ctx.root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(ctx.readFile(pkgPath));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      for (const [name, version] of Object.entries(allDeps || {})) {
        if (name.startsWith('@') && !isPublicScope(name)) {
          results.push({
            name,
            version,
            type: 'package',
            usage: `npm dependency`,
          });
        }
      }
    } catch { /* ignore */ }
  }

  // Python: org-prefixed packages from requirements.txt
  const reqFiles = ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt'];
  for (const reqFile of reqFiles) {
    const reqPath = path.join(ctx.root, reqFile);
    if (!fs.existsSync(reqPath)) continue;
    const content = ctx.readFile(reqPath);
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)/);
      if (match) {
        const pkg = match[1];
        // Heuristic: packages with org-like prefixes (company-*, org-*)
        if (pkg.includes('-') && !isPublicPyPIPackage(pkg)) {
          // This is a rough heuristic — will have false positives
          // Only include if it looks org-scoped
        }
      }
    }
  }

  return results;
}

// ============================================================
// Utility Functions
// ============================================================

function collectFiles(root, ignorePatterns) {
  const DEFAULT_IGNORE = [
    'node_modules', '.git', 'dist', 'build', '__pycache__',
    '.tox', '.mypy_cache', '.pytest_cache', 'venv', '.venv',
    'env', '.env', 'coverage', '.nyc_output', '.next',
    'vendor', 'target', '.forge',
  ];

  const ignore = new Set([...DEFAULT_IGNORE, ...(ignorePatterns || [])]);
  const files = [];

  function walk(dir, depth) {
    if (depth > 10) return; // Safety limit
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.example') continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        // Only include relevant file types
        if (isRelevantFile(entry.name)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(root, 0);
  return files;
}

function isRelevantFile(name) {
  const RELEVANT_EXTENSIONS = new Set([
    '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx',
    '.py', '.java', '.go', '.rs', '.rb',
    '.yaml', '.yml', '.json', '.toml',
    '.proto', '.prisma', '.graphql', '.gql',
    '.sql', '.env', '.env.example', '.env.sample',
  ]);

  const ext = path.extname(name).toLowerCase();
  if (RELEVANT_EXTENSIONS.has(ext)) return true;
  if (name === 'Dockerfile' || name === 'docker-compose.yml' || name === 'docker-compose.yaml') return true;
  if (name === 'package.json' || name === 'setup.py' || name === 'pyproject.toml') return true;
  if (name === 'requirements.txt') return true;
  return false;
}

function deduplicateInterfaces(interfaces) {
  const seen = new Map();
  for (const iface of interfaces) {
    const key = `${iface.type}:${iface.protocol || ''}:${iface.name}`;
    if (!seen.has(key)) {
      // Remove internal fields
      const clean = { ...iface };
      delete clean._detector;
      seen.set(key, clean);
    }
  }
  return [...seen.values()];
}

function deduplicateImports(imports) {
  const seen = new Map();
  for (const imp of imports) {
    const key = `${imp.type}:${imp.service || ''}:${imp.name || imp.topic || ''}`;
    if (!seen.has(key)) {
      const clean = { ...imp };
      delete clean._detector;
      seen.set(key, clean);
    }
  }
  return [...seen.values()];
}

function findCommonPrefix(paths) {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0];

  const parts = paths.map(p => p.split('/'));
  const common = [];
  for (let i = 0; i < parts[0].length; i++) {
    const segment = parts[0][i];
    if (parts.every(p => p[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }
  return common.join('/') || '/';
}

function inferServiceFromURL(url) {
  // Try to extract service name from URL
  const match = url.match(/(?:https?:\/\/)?([a-z0-9-]+)(?:[.:]\d+)?/i);
  if (match) return match[1];
  return 'unknown-service';
}

function inferServiceFromTopic(topic) {
  // Common pattern: service-name.event-name
  const parts = topic.split('.');
  if (parts.length >= 2) return parts[0] + '-service';
  return 'unknown-service';
}

function inferServiceFromTask(taskName) {
  // Common pattern: module.task_name or app.tasks.task_name
  const parts = taskName.split('.');
  if (parts.length >= 2) return parts[0] + '-service';
  return 'unknown-service';
}

function sanitizeName(name) {
  // Remove npm scope, convert to kebab-case
  return name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

function quote(str) {
  if (!str) return '""';
  if (str.includes(':') || str.includes('#') || str.includes('"') || str.includes("'") || str.startsWith('@')) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

function isPublicScope(packageName) {
  const PUBLIC_SCOPES = new Set([
    '@types', '@babel', '@jest', '@testing-library', '@nestjs', '@angular',
    '@vue', '@nuxt', '@svelte', '@vitejs', '@rollup', '@webpack',
    '@eslint', '@typescript-eslint', '@graphql-tools', '@apollo',
    '@prisma', '@trpc', '@tanstack', '@radix-ui', '@headlessui',
    '@heroicons', '@tailwindcss', '@emotion', '@mui', '@chakra-ui',
    '@reduxjs', '@react-native', '@expo', '@aws-sdk', '@azure',
    '@google-cloud', '@octokit', '@sentry', '@opentelemetry',
    '@fastify', '@hapi', '@koa', '@grpc',
  ]);
  const scope = packageName.split('/')[0];
  return PUBLIC_SCOPES.has(scope);
}

function isPublicPyPIPackage(name) {
  // Very rough heuristic — well-known packages
  const KNOWN_PUBLIC = new Set([
    'flask', 'django', 'fastapi', 'celery', 'redis', 'sqlalchemy',
    'alembic', 'pytest', 'requests', 'httpx', 'pydantic', 'uvicorn',
    'gunicorn', 'boto3', 'numpy', 'pandas', 'scipy',
  ]);
  return KNOWN_PUBLIC.has(name.toLowerCase());
}

// ============================================================
// CLI Entry Point
// ============================================================

function printSummary(detection, opts = {}) {
  let chalk;
  try {
    chalk = require('chalk');
  } catch {
    chalk = { bold: s => s, green: s => s, yellow: s => s, cyan: s => s, dim: s => s, red: s => s };
  }

  console.log('');
  console.log(chalk.bold('  Interface Detection Results'));
  console.log(chalk.dim('  ─────────────────────────────'));
  console.log(`  Service:  ${chalk.cyan(detection.service.name)}`);
  console.log(`  Repo:     ${detection.service.repo}`);
  if (detection.service.version) console.log(`  Version:  ${detection.service.version}`);
  console.log('');

  if (detection.exports.length > 0) {
    console.log(chalk.bold(`  Exports (${detection.exports.length}):`));
    for (const exp of detection.exports) {
      const count = exp.endpoints ? ` (${exp.endpoints.length} endpoints)` : '';
      const tables = exp.tables ? ` [${exp.tables.length} tables]` : '';
      const methods = exp.methods ? ` [${exp.methods.length} methods]` : '';
      console.log(`    ${chalk.green('▸')} ${exp.type}/${exp.protocol || ''} ${chalk.bold(exp.name)}${count}${tables}${methods}`);
    }
    console.log('');
  }

  if (detection.imports.length > 0) {
    console.log(chalk.bold(`  Imports (${detection.imports.length}):`));
    for (const imp of detection.imports) {
      const svc = imp.service ? ` → ${imp.service}` : '';
      console.log(`    ${chalk.yellow('◂')} ${imp.type} ${chalk.bold(imp.name || imp.topic || '')}${svc}`);
    }
    console.log('');
  }

  if (detection.exports.length === 0 && detection.imports.length === 0) {
    console.log(chalk.dim('  No interfaces detected. This may be an internal service or library.'));
    console.log('');
  }

  console.log(chalk.dim(`  Files scanned: ${detection.stats.files_scanned}`));
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootDir = args.find(a => !a.startsWith('--')) || '.';
  const jsonOutput = args.includes('--json');
  const writeFile = !args.includes('--no-write');

  const detection = detectInterfaces(rootDir);

  if (jsonOutput) {
    console.log(JSON.stringify(detection, null, 2));
  } else {
    printSummary(detection);

    if (writeFile && (detection.exports.length > 0 || detection.imports.length > 0)) {
      const yaml = generateYAML(detection);
      const filePath = writeInterfacesYAML(rootDir, yaml);
      let chalk;
      try { chalk = require('chalk'); } catch { chalk = { green: s => s, dim: s => s }; }
      console.log(`  ${chalk.green('✓')} Written to ${chalk.dim(filePath)}`);
      console.log(`  ${chalk.dim('  Review and adjust before committing.')}`);
      console.log('');
    }
  }
}

// ============================================================
// Module Exports
// ============================================================

module.exports = {
  detectInterfaces,
  generateYAML,
  writeInterfacesYAML,
  printSummary,
  // Individual detectors for testing
  detectOpenAPI,
  detectFastAPI,
  detectExpress,
  detectGRPC,
  detectKafkaProducer,
  detectRabbitMQProducer,
  detectCeleryTasks,
  detectRedisPubSub,
  detectNpmPackage,
  detectPyPIPackage,
  detectDatabaseModels,
  detectEnvAPIURLs,
  detectHTTPClients,
  detectKafkaConsumer,
  detectCeleryCaller,
  detectOrgPackages,
  // Utilities
  collectFiles,
  detectServiceIdentity,
  EXPORT_DETECTORS,
  IMPORT_DETECTORS,
};
