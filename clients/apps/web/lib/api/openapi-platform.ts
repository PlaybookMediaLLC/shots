import { z } from 'zod'
import type { ContractAccess } from '@/lib/api/access-requirements'
import {
  type ContractDocs,
  type DocumentedStatus,
  noInputSchema,
  type RouteContract,
} from '@/lib/api/contract'
import { documentedContracts } from '@/lib/api/contracts'
import { platformErrorBodySchema } from '@/lib/api/platform-errors'
import {
  getMinimumPlan,
  workspaceFeatureSchema,
  workspacePlanSchema,
  workspaceQuotaSchema,
} from '@/lib/billing/plans'

/**
 * The platform half of the OpenAPI spec, generated from the route contracts
 * with `z.toJSONSchema`, so the docs cannot drift from what the routes
 * validate. `lib/api/openapi.ts` merges it with the editor operations.
 */

/** A JSON Schema or OpenAPI object. */
export const openApiObjectSchema = z.record(z.string(), z.unknown())

/** One of {@link openApiObjectSchema}. */
export type OpenApiObject = z.infer<typeof openApiObjectSchema>

/** Which side of a schema to describe: what a request sends, or what a response carries. */
export const schemaDirectionSchema = z.enum(['input', 'output'])

/** Where an OpenAPI parameter lives. */
export const parameterLocationSchema = z.enum(['path', 'query', 'header'])

const objectJsonSchema = z.object({
  properties: openApiObjectSchema.default({}),
  required: z.array(z.string()).default([]),
})

/** Error components every documented failure references. */
export const errorComponentSchemas = {
  Error: platformErrorBodySchema,
  WorkspaceEntitlementError: platformErrorBodySchema.extend({
    currentPlan: workspacePlanSchema,
    feature: workspaceFeatureSchema,
    requiredPlan: workspacePlanSchema,
  }),
  WorkspaceQuotaError: platformErrorBodySchema.extend({
    limit: z.int(),
    quota: workspaceQuotaSchema,
  }),
}

function toJsonSchema(schema: z.ZodType, io: z.infer<typeof schemaDirectionSchema>): OpenApiObject {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io, unrepresentable: 'any' })
  return json
}

function componentRef(name: string): OpenApiObject {
  return { $ref: `#/components/schemas/${name}` }
}

function jsonContent(schema: OpenApiObject): OpenApiObject {
  return { content: { 'application/json': { schema } } }
}

function headerName(name: string): string {
  return name.replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => {
    return dash + letter.toUpperCase()
  })
}

function parametersIn(
  schema: z.ZodType,
  location: z.infer<typeof parameterLocationSchema>
): OpenApiObject[] {
  if (schema === noInputSchema) return []
  const { properties, required } = objectJsonSchema.parse(toJsonSchema(schema, 'input'))
  return Object.entries(properties).map(([name, property]) => ({
    in: location,
    name: location === parameterLocationSchema.enum.header ? headerName(name) : name,
    required: location === parameterLocationSchema.enum.path || required.includes(name),
    schema: property,
  }))
}

function responseFor(
  contract: RouteContract,
  status: DocumentedStatus,
  description: string
): OpenApiObject {
  const code = Number(status)
  if (code === 429) return { description, ...jsonContent(componentRef('WorkspaceQuotaError')) }
  if (code >= 400) return { description, ...jsonContent(componentRef('Error')) }
  if (code === 204) return { description }
  const name = contract.docs?.outputName
  const schema = name ? componentRef(name) : toJsonSchema(contract.output, 'output')
  return { description, ...jsonContent(schema) }
}

function requestBodyFor(contract: RouteContract, docs: ContractDocs): OpenApiObject {
  if (contract.body === noInputSchema) return {}
  const schema = docs.bodyName ? componentRef(docs.bodyName) : toJsonSchema(contract.body, 'input')
  return { requestBody: { required: true, ...jsonContent(schema) } }
}

/**
 * The plan gate an operation publishes as `x-shots-entitlement`. Every tenant
 * operation needs `workspace:use`; a declared feature is the stricter gate.
 */
export const shotsEntitlementSchema = z.object({
  feature: workspaceFeatureSchema,
  minimumPlan: workspacePlanSchema,
  quota: workspaceQuotaSchema.optional(),
})

/** One of {@link shotsEntitlementSchema}. */
export type ShotsEntitlement = z.infer<typeof shotsEntitlementSchema>

/** The `x-shots-entitlement` of an operation that declares `access`. */
export function entitlementFor(access: ContractAccess): ShotsEntitlement {
  const feature = access.feature ?? workspaceFeatureSchema.enum['workspace:use']
  return shotsEntitlementSchema.parse({
    feature,
    minimumPlan: getMinimumPlan(feature),
    ...(access.quota ? { quota: access.quota } : {}),
  })
}

/**
 * The OpenAPI security requirements. A tenant operation takes an API key with
 * its scope, or a member session; a member operation takes the session only.
 */
function securityFor(contract: RouteContract, docs: ContractDocs): OpenApiObject[] {
  const { access } = contract
  if (!access) return [{ [docs.security ?? 'workspaceSession']: [] }]
  if ('apiKeyOnly' in access) return [{ workspaceApiKey: [] }]
  const session = { workspaceSession: [] }
  return 'apiKeyScope' in access ? [{ workspaceApiKey: [access.apiKeyScope] }, session] : [session]
}

function operationFor(contract: RouteContract, docs: ContractDocs): OpenApiObject {
  const parameters = [
    ...parametersIn(contract.params, 'path'),
    ...parametersIn(contract.query, 'query'),
    ...parametersIn(contract.headers, 'header'),
  ]
  return {
    ...docs.extensions,
    ...(contract.access ? { 'x-shots-entitlement': entitlementFor(contract.access) } : {}),
    description: docs.description,
    operationId: docs.operationId,
    ...(parameters.length ? { parameters } : {}),
    ...requestBodyFor(contract, docs),
    responses: Object.fromEntries(
      Object.entries(docs.responses).map(([status, description]) => [
        status,
        responseFor(contract, status as DocumentedStatus, description),
      ])
    ),
    security: securityFor(contract, docs),
    summary: contract.summary,
    tags: [docs.tag],
  }
}

function componentsFor(contracts: readonly RouteContract[]): Record<string, OpenApiObject> {
  const schemas: Record<string, OpenApiObject> = {}
  for (const contract of contracts) {
    if (contract.docs?.bodyName) {
      schemas[contract.docs.bodyName] = toJsonSchema(contract.body, 'input')
    }
    if (contract.docs?.outputName) {
      schemas[contract.docs.outputName] = toJsonSchema(contract.output, 'output')
    }
  }
  for (const [name, schema] of Object.entries(errorComponentSchemas)) {
    schemas[name] = toJsonSchema(schema, 'output')
  }
  return schemas
}

/** Build the OpenAPI `paths` and component `schemas` for documented contracts. */
export function buildPlatformOpenApi(contracts: readonly RouteContract[]) {
  const paths: Record<string, Record<string, OpenApiObject>> = {}
  for (const contract of contracts) {
    if (!contract.docs) continue
    paths[contract.path] ??= {}
    paths[contract.path][contract.method.toLowerCase()] = operationFor(contract, contract.docs)
  }
  return { paths, schemas: componentsFor(contracts) }
}

/** The generated platform paths and schemas for the public spec. */
export const platformOpenApi = buildPlatformOpenApi(documentedContracts)
