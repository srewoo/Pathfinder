/**
 * Client-side OpenAPI/Swagger specification parser.
 *
 * Parses OpenAPI 3.x and Swagger 2.0 JSON specs (user uploads the file).
 * Extracts API endpoints, request/response schemas, validation rules,
 * and converts them into context that can enhance test generation.
 *
 * No backend needed — all parsing happens in the browser.
 */
// ── Types ───────────────────────────────────────────────────────────────────

export interface APIEndpoint {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters: APIParameter[];
  requestBody?: APIRequestBody;
  responses: APIResponse[];
}

export interface APIParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  type?: string;
  format?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface APIRequestBody {
  contentType: string;
  required: boolean;
  properties: APIProperty[];
}

export interface APIProperty {
  name: string;
  type: string;
  format?: string;
  required: boolean;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  example?: unknown;
  items?: APIProperty; // For arrays
}

export interface APIResponse {
  statusCode: string;
  description: string;
  contentType?: string;
  properties?: APIProperty[];
}

export interface ParsedAPISpec {
  title: string;
  version: string;
  baseUrl: string;
  endpoints: APIEndpoint[];
  /** Summary text suitable for LLM context */
  summary: string;
}

// ── Main Parser ─────────────────────────────────────────────────────────────

/**
 * Parse an OpenAPI/Swagger spec from a JSON string.
 * Supports OpenAPI 3.0/3.1 and Swagger 2.0.
 */
export function parseOpenAPISpec(jsonString: string): ParsedAPISpec {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON — could not parse the OpenAPI spec file.');
  }

  if (spec['openapi'] && String(spec['openapi']).startsWith('3.')) {
    return parseOpenAPI3(spec);
  }
  if (spec['swagger'] && String(spec['swagger']).startsWith('2.')) {
    return parseSwagger2(spec);
  }

  throw new Error('Unsupported spec format. Expected OpenAPI 3.x or Swagger 2.0.');
}

// ── OpenAPI 3.x Parser ──────────────────────────────────────────────────────

function parseOpenAPI3(spec: Record<string, unknown>): ParsedAPISpec {
  const info = (spec['info'] ?? {}) as Record<string, unknown>;
  const title = String(info['title'] ?? 'API');
  const version = String(info['version'] ?? '1.0');

  // Extract base URL from servers
  const servers = (spec['servers'] ?? []) as Array<Record<string, unknown>>;
  const baseUrl = servers.length > 0 ? String(servers[0]['url'] ?? '') : '';

  const paths = (spec['paths'] ?? {}) as Record<string, Record<string, unknown>>;
  const components = (spec['components'] ?? {}) as Record<string, unknown>;
  const schemas = (components['schemas'] ?? {}) as Record<string, unknown>;

  const endpoints: APIEndpoint[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const endpoint: APIEndpoint = {
        path,
        method: method.toUpperCase(),
        operationId: operation['operationId'] as string | undefined,
        summary: operation['summary'] as string | undefined,
        description: operation['description'] as string | undefined,
        tags: operation['tags'] as string[] | undefined,
        parameters: extractParameters(operation['parameters'] as unknown[] | undefined, schemas),
        responses: extractResponses3(operation['responses'] as Record<string, unknown> | undefined, schemas),
      };

      // Request body
      const reqBody = operation['requestBody'] as Record<string, unknown> | undefined;
      if (reqBody) {
        endpoint.requestBody = extractRequestBody3(reqBody, schemas);
      }

      endpoints.push(endpoint);
    }
  }

  const summary = serializeForAI(title, version, baseUrl, endpoints);

  return { title, version, baseUrl, endpoints, summary };
}

// ── Swagger 2.0 Parser ──────────────────────────────────────────────────────

function parseSwagger2(spec: Record<string, unknown>): ParsedAPISpec {
  const info = (spec['info'] ?? {}) as Record<string, unknown>;
  const title = String(info['title'] ?? 'API');
  const version = String(info['version'] ?? '1.0');
  const host = String(spec['host'] ?? '');
  const basePath = String(spec['basePath'] ?? '');
  const schemesArr = (spec['schemes'] ?? ['https']) as string[];
  const baseUrl = `${schemesArr[0]}://${host}${basePath}`;

  const definitions = (spec['definitions'] ?? {}) as Record<string, unknown>;
  const paths = (spec['paths'] ?? {}) as Record<string, Record<string, unknown>>;

  const endpoints: APIEndpoint[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const rawParams = (operation['parameters'] ?? []) as Array<Record<string, unknown>>;

      // Separate body params from others
      const bodyParam = rawParams.find((p) => p['in'] === 'body');
      const nonBodyParams = rawParams.filter((p) => p['in'] !== 'body');

      const endpoint: APIEndpoint = {
        path,
        method: method.toUpperCase(),
        operationId: operation['operationId'] as string | undefined,
        summary: operation['summary'] as string | undefined,
        description: operation['description'] as string | undefined,
        tags: operation['tags'] as string[] | undefined,
        parameters: nonBodyParams.map((p) => extractSwagger2Param(p)),
        responses: extractResponses2(operation['responses'] as Record<string, unknown> | undefined, definitions),
      };

      if (bodyParam) {
        const schema = resolveRef(bodyParam['schema'] as Record<string, unknown>, definitions);
        endpoint.requestBody = {
          contentType: 'application/json',
          required: bodyParam['required'] === true,
          properties: extractSchemaProperties(schema, definitions),
        };
      }

      endpoints.push(endpoint);
    }
  }

  const summary = serializeForAI(title, version, baseUrl, endpoints);
  return { title, version, baseUrl, endpoints, summary };
}

// ── Extraction Helpers ──────────────────────────────────────────────────────

function extractParameters(
  params: unknown[] | undefined,
  schemas: Record<string, unknown>
): APIParameter[] {
  if (!Array.isArray(params)) return [];

  return params.map((p) => {
    const param = p as Record<string, unknown>;
    const schema = resolveRef((param['schema'] ?? {}) as Record<string, unknown>, schemas);

    return {
      name: String(param['name'] ?? ''),
      in: String(param['in'] ?? 'query') as APIParameter['in'],
      required: param['required'] === true,
      description: param['description'] as string | undefined,
      type: String(schema['type'] ?? param['type'] ?? 'string'),
      format: schema['format'] as string | undefined,
      enum: schema['enum'] as string[] | undefined,
      minimum: schema['minimum'] as number | undefined,
      maximum: schema['maximum'] as number | undefined,
      minLength: schema['minLength'] as number | undefined,
      maxLength: schema['maxLength'] as number | undefined,
      pattern: schema['pattern'] as string | undefined,
    };
  });
}

function extractSwagger2Param(p: Record<string, unknown>): APIParameter {
  return {
    name: String(p['name'] ?? ''),
    in: String(p['in'] ?? 'query') as APIParameter['in'],
    required: p['required'] === true,
    description: p['description'] as string | undefined,
    type: String(p['type'] ?? 'string'),
    format: p['format'] as string | undefined,
    enum: p['enum'] as string[] | undefined,
    minimum: p['minimum'] as number | undefined,
    maximum: p['maximum'] as number | undefined,
    minLength: p['minLength'] as number | undefined,
    maxLength: p['maxLength'] as number | undefined,
    pattern: p['pattern'] as string | undefined,
  };
}

function extractRequestBody3(
  reqBody: Record<string, unknown>,
  schemas: Record<string, unknown>
): APIRequestBody | undefined {
  const content = (reqBody['content'] ?? {}) as Record<string, unknown>;
  const jsonContent = content['application/json'] as Record<string, unknown> | undefined;
  const formContent = content['application/x-www-form-urlencoded'] as Record<string, unknown> | undefined;
  const multipartContent = content['multipart/form-data'] as Record<string, unknown> | undefined;

  const chosen = jsonContent ?? formContent ?? multipartContent;
  if (!chosen) return undefined;

  const contentType = jsonContent ? 'application/json'
    : formContent ? 'application/x-www-form-urlencoded'
    : 'multipart/form-data';

  const schema = resolveRef((chosen['schema'] ?? {}) as Record<string, unknown>, schemas);

  return {
    contentType,
    required: reqBody['required'] === true,
    properties: extractSchemaProperties(schema, schemas),
  };
}

function extractSchemaProperties(
  schema: Record<string, unknown>,
  schemas: Record<string, unknown>,
  depth = 0
): APIProperty[] {
  if (depth > 3) return []; // Prevent infinite recursion

  const resolved = resolveRef(schema, schemas);
  const type = String(resolved['type'] ?? 'object');

  if (type !== 'object') return [];

  const properties = (resolved['properties'] ?? {}) as Record<string, unknown>;
  const requiredFields = new Set((resolved['required'] ?? []) as string[]);
  const result: APIProperty[] = [];

  for (const [name, propSchema] of Object.entries(properties)) {
    const prop = resolveRef(propSchema as Record<string, unknown>, schemas);
    const propType = String(prop['type'] ?? 'string');

    const apiProp: APIProperty = {
      name,
      type: propType,
      format: prop['format'] as string | undefined,
      required: requiredFields.has(name),
      description: prop['description'] as string | undefined,
      enum: prop['enum'] as string[] | undefined,
      minimum: prop['minimum'] as number | undefined,
      maximum: prop['maximum'] as number | undefined,
      minLength: prop['minLength'] as number | undefined,
      maxLength: prop['maxLength'] as number | undefined,
      pattern: prop['pattern'] as string | undefined,
      example: prop['example'],
    };

    // Handle array items
    if (propType === 'array' && prop['items']) {
      const items = resolveRef(prop['items'] as Record<string, unknown>, schemas);
      apiProp.items = {
        name: 'item',
        type: String(items['type'] ?? 'string'),
        required: false,
        enum: items['enum'] as string[] | undefined,
      };
    }

    result.push(apiProp);
  }

  return result;
}

function extractResponses3(
  responses: Record<string, unknown> | undefined,
  schemas: Record<string, unknown>
): APIResponse[] {
  if (!responses) return [];

  return Object.entries(responses).map(([statusCode, responseObj]) => {
    const resp = responseObj as Record<string, unknown>;
    const content = (resp['content'] ?? {}) as Record<string, unknown>;
    const jsonContent = content['application/json'] as Record<string, unknown> | undefined;

    let properties: APIProperty[] | undefined;
    if (jsonContent) {
      const schema = resolveRef((jsonContent['schema'] ?? {}) as Record<string, unknown>, schemas);
      properties = extractSchemaProperties(schema, schemas);
    }

    return {
      statusCode,
      description: String(resp['description'] ?? ''),
      contentType: jsonContent ? 'application/json' : undefined,
      properties,
    };
  });
}

function extractResponses2(
  responses: Record<string, unknown> | undefined,
  definitions: Record<string, unknown>
): APIResponse[] {
  if (!responses) return [];

  return Object.entries(responses).map(([statusCode, responseObj]) => {
    const resp = responseObj as Record<string, unknown>;

    let properties: APIProperty[] | undefined;
    if (resp['schema']) {
      const schema = resolveRef(resp['schema'] as Record<string, unknown>, definitions);
      properties = extractSchemaProperties(schema, definitions);
    }

    return {
      statusCode,
      description: String(resp['description'] ?? ''),
      properties,
    };
  });
}

function resolveRef(schema: Record<string, unknown>, schemas: Record<string, unknown>): Record<string, unknown> {
  const ref = schema['$ref'] as string | undefined;
  if (!ref) return schema;

  // Handle #/components/schemas/Name and #/definitions/Name
  const parts = ref.split('/');
  const name = parts[parts.length - 1];

  const resolved = schemas[name] as Record<string, unknown> | undefined;
  return resolved ?? schema;
}

// ── Serialization for AI Context ────────────────────────────────────────────

/**
 * Serialize parsed API spec into a compact text format for LLM context.
 * Focuses on information useful for test generation: endpoints, validation rules,
 * request/response schemas.
 */
function serializeForAI(title: string, version: string, baseUrl: string, endpoints: APIEndpoint[]): string {
  const lines: string[] = [
    `API: ${title} v${version}`,
    `Base URL: ${baseUrl}`,
    '',
    `## Endpoints (${endpoints.length} total)`,
    '',
  ];

  for (const ep of endpoints.slice(0, 200)) { // Cap at 200 endpoints
    lines.push(`### ${ep.method} ${ep.path}`);
    if (ep.summary) lines.push(`  Summary: ${ep.summary}`);
    if (ep.tags?.length) lines.push(`  Tags: ${ep.tags.join(', ')}`);

    if (ep.parameters.length > 0) {
      lines.push('  Parameters:');
      for (const p of ep.parameters) {
        let desc = `    - ${p.name} (${p.in}, ${p.type}${p.required ? ', required' : ''})`;
        if (p.enum) desc += ` enum=[${p.enum.join('|')}]`;
        if (p.minimum !== undefined) desc += ` min=${p.minimum}`;
        if (p.maximum !== undefined) desc += ` max=${p.maximum}`;
        if (p.minLength !== undefined) desc += ` minLen=${p.minLength}`;
        if (p.maxLength !== undefined) desc += ` maxLen=${p.maxLength}`;
        if (p.pattern) desc += ` pattern=${p.pattern}`;
        lines.push(desc);
      }
    }

    if (ep.requestBody) {
      lines.push(`  Request Body (${ep.requestBody.contentType}${ep.requestBody.required ? ', required' : ''}):`);
      for (const p of ep.requestBody.properties) {
        let desc = `    - ${p.name}: ${p.type}${p.format ? `(${p.format})` : ''}${p.required ? ' (required)' : ''}`;
        if (p.enum) desc += ` enum=[${p.enum.join('|')}]`;
        if (p.minimum !== undefined) desc += ` min=${p.minimum}`;
        if (p.maximum !== undefined) desc += ` max=${p.maximum}`;
        if (p.minLength !== undefined) desc += ` minLen=${p.minLength}`;
        if (p.maxLength !== undefined) desc += ` maxLen=${p.maxLength}`;
        if (p.pattern) desc += ` pattern=${p.pattern}`;
        if (p.example !== undefined) desc += ` example=${JSON.stringify(p.example)}`;
        lines.push(desc);
      }
    }

    if (ep.responses.length > 0) {
      lines.push('  Responses:');
      for (const r of ep.responses) {
        lines.push(`    ${r.statusCode}: ${r.description}`);
      }
    }

    lines.push('');
  }

  const result = lines.join('\n');
  // Cap at ~10000 chars for token budget
  return result.length > 40000 ? result.slice(0, 40000) + '\n... (truncated)' : result;
}

/**
 * Generate test-relevant validation rules from an API spec.
 * Returns a compact string describing what validations the API enforces.
 */
export function extractValidationRules(spec: ParsedAPISpec): string {
  const rules: string[] = [];

  for (const ep of spec.endpoints) {
    const epRules: string[] = [];

    // Required parameters
    const requiredParams = ep.parameters.filter((p) => p.required);
    if (requiredParams.length > 0) {
      epRules.push(`Required params: ${requiredParams.map((p) => p.name).join(', ')}`);
    }

    // Request body validations
    if (ep.requestBody) {
      const requiredFields = ep.requestBody.properties.filter((p) => p.required);
      if (requiredFields.length > 0) {
        epRules.push(`Required fields: ${requiredFields.map((p) => p.name).join(', ')}`);
      }

      for (const prop of ep.requestBody.properties) {
        if (prop.minLength !== undefined || prop.maxLength !== undefined) {
          epRules.push(`${prop.name}: length ${prop.minLength ?? 0}-${prop.maxLength ?? '∞'}`);
        }
        if (prop.minimum !== undefined || prop.maximum !== undefined) {
          epRules.push(`${prop.name}: range ${prop.minimum ?? '-∞'}-${prop.maximum ?? '∞'}`);
        }
        if (prop.pattern) {
          epRules.push(`${prop.name}: pattern ${prop.pattern}`);
        }
        if (prop.format === 'email') {
          epRules.push(`${prop.name}: must be valid email`);
        }
        if (prop.format === 'uri' || prop.format === 'url') {
          epRules.push(`${prop.name}: must be valid URL`);
        }
        if (prop.enum) {
          epRules.push(`${prop.name}: must be one of [${prop.enum.join(', ')}]`);
        }
      }
    }

    // Error responses
    const errorResponses = ep.responses.filter((r) =>
      r.statusCode.startsWith('4') || r.statusCode.startsWith('5')
    );
    if (errorResponses.length > 0) {
      epRules.push(`Error codes: ${errorResponses.map((r) => `${r.statusCode} (${r.description})`).join(', ')}`);
    }

    if (epRules.length > 0) {
      rules.push(`${ep.method} ${ep.path}:\n  ${epRules.join('\n  ')}`);
    }
  }

  return rules.join('\n\n');
}
