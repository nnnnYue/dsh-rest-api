import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { RouteSpec } from '../http.ts'
import { HttpError, json } from '../errors.ts'
import type { Deps } from '../types.ts'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Skill layers this plugin may write. Bundled/runtime skills stay read-only. */
const WRITABLE_SOURCES = new Set(['user-dsh', 'project-dsh'])

/**
 * The skill-filesystem provider registers into a scope-keyed layer of the
 * SkillRegistry (its loader fiber is scoped), so a scope-less view only sees
 * the global layer. Resolve the scope key hosting the `filesystem` provider
 * once per process and pass it on every read; older compositions that
 * register globally fall back to the scope-less view.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
let cachedViewScope: unknown
let viewScopeResolved = false

function resolveViewScope(skills: unknown): unknown {
  if (viewScopeResolved) return cachedViewScope
  viewScopeResolved = true
  const scoped: Map<object, any> | undefined = (skills as any)?.layers?.scoped
  if (scoped instanceof Map) {
    for (const [scopeKey, layer] of scoped) {
      const providers = layer?.providers?.data
      if (providers instanceof Map && providers.has('filesystem')) {
        cachedViewScope = scopeKey
        break
      }
    }
  }
  return cachedViewScope
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function userSkillsDir(): string {
  return path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'skills')
}

function yamlString(value: string): string {
  // JSON double-quoted strings are valid YAML double-quoted scalars.
  return JSON.stringify(value)
}

function buildSkillMarkdown(skill: {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  body: string
}): string {
  const lines = ['---', `name: ${yamlString(skill.name)}`, `description: ${yamlString(skill.description)}`]
  if (skill.whenToUse !== undefined) lines.push(`whenToUse: ${yamlString(skill.whenToUse)}`)
  if (!skill.modelInvocable) lines.push('disable-model-invocation: true')
  if (!skill.userInvocable) lines.push('user-invocable: false')
  lines.push('---', '', skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`)
  return lines.join('\n')
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, filePath)
}

/**
 * Skills management. Enumeration goes through `ctx.skills` so project, user,
 * custom, and bundled layers all appear with their winning rank; writes land
 * in the two filesystem layers (`~/.dsh/skills/<name>/SKILL.md` and
 * `<cwd>/.dsh/skills/<name>/SKILL.md`), where the skill-filesystem watcher
 * picks them up and fires `skills/change` — no restart, WebUI included.
 */
export function skillRoutes(deps: Deps): RouteSpec[] {
  const { skills } = deps

  /** View options carrying the resolved scope plus an optional cwd. */
  function viewOptions(query?: URLSearchParams): Record<string, unknown> {
    const scope = resolveViewScope(skills)
    const cwd = query?.get('cwd') ?? undefined
    return {
      ...(scope !== undefined ? { scope } : {}),
      ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
    }
  }

  function assertWritableSource(source: string): void {
    if (!WRITABLE_SOURCES.has(source)) {
      throw new HttpError(409, 'skills/read-only-source',
        `skill source "${source}" is not writable via the REST API (writable: ${[...WRITABLE_SOURCES].join(', ')})`)
    }
  }

  return [
    {
      method: 'GET',
      path: '/skills',
      async handler(_req, res, _params, _body, query) {
        const snapshot = await skills.snapshot(viewOptions(query) as never)
        json(res, 200, { complete: snapshot.complete, items: snapshot.skills })
      },
    },
    {
      method: 'GET',
      path: '/skills/:name',
      async handler(_req, res, params, _body, query) {
        const definition = await skills.get(params.name!, viewOptions(query) as never)
        if (definition === undefined) throw new HttpError(404, 'skills/not-found', `skill "${params.name}" not found`)
        json(res, 200, definition)
      },
    },
    {
      method: 'POST',
      path: '/skills',
      async handler(_req, res, _params, body) {
        const {
          name,
          description,
          body: skillBody,
          whenToUse,
          modelInvocable = true,
          userInvocable = true,
          layer = 'user',
          cwd,
        } = (body ?? {}) as {
          name?: unknown
          description?: unknown
          body?: unknown
          whenToUse?: unknown
          modelInvocable?: unknown
          userInvocable?: unknown
          layer?: unknown
          cwd?: unknown
        }
        if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
          throw new HttpError(400, 'gateway/bad-request', 'body.name must match ^[a-z0-9]+(-[a-z0-9]+)*$')
        }
        if (typeof description !== 'string' || description.length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.description is required')
        }
        if (typeof skillBody !== 'string' || skillBody.trim().length === 0) {
          throw new HttpError(400, 'gateway/bad-request', 'body.body (markdown instruction content) is required')
        }
        let root: string
        if (layer === 'user') {
          root = userSkillsDir()
        } else if (layer === 'project') {
          if (typeof cwd !== 'string' || cwd.length === 0) {
            throw new HttpError(400, 'gateway/bad-request', 'body.cwd is required for layer "project"')
          }
          root = path.join(cwd, '.dsh', 'skills')
        } else {
          throw new HttpError(400, 'gateway/bad-request', 'body.layer must be "user" or "project"')
        }
        const markdown = buildSkillMarkdown({
          name,
          description,
          ...(typeof whenToUse === 'string' ? { whenToUse } : {}),
          modelInvocable: modelInvocable !== false,
          userInvocable: userInvocable !== false,
          body: skillBody,
        })
        const filePath = path.join(root, name, 'SKILL.md')
        const existing = await skills.get(name, viewOptions() as never)
        if (existing !== undefined && existing.source !== 'user-dsh' && existing.source !== 'bundled') {
          throw new HttpError(409, 'skills/conflict', `skill "${name}" already exists at a higher-rank layer (${existing.path})`)
        }
        await atomicWrite(filePath, markdown)
        json(res, 201, { name, layer, path: filePath, modelInvocable: modelInvocable !== false, userInvocable: userInvocable !== false })
      },
    },
    {
      method: 'PATCH',
      path: '/skills/:name',
      async handler(_req, res, params, body, query) {
        const name = params.name!
        const definition = await skills.get(name, viewOptions(query) as never)
        if (definition === undefined) throw new HttpError(404, 'skills/not-found', `skill "${name}" not found`)
        assertWritableSource(definition.source)
        const filePath = definition.path
        if (filePath === undefined) throw new HttpError(409, 'skills/no-file', 'runtime skills have no backing file')
        const patch = (body ?? {}) as Record<string, unknown>
        const next = {
          name: definition.name,
          description: typeof patch.description === 'string' ? patch.description : definition.description,
          whenToUse: typeof patch.whenToUse === 'string' ? patch.whenToUse : definition.whenToUse,
          modelInvocable: typeof patch.modelInvocable === 'boolean' ? patch.modelInvocable : definition.invocation.modelInvocable,
          userInvocable: typeof patch.userInvocable === 'boolean' ? patch.userInvocable : definition.invocation.userInvocable,
          body: typeof patch.body === 'string' ? patch.body : definition.content,
        }
        await atomicWrite(filePath, buildSkillMarkdown(next))
        json(res, 200, { ...next, path: filePath })
      },
    },
    {
      method: 'DELETE',
      path: '/skills/:name',
      async handler(_req, res, params, _body, query) {
        const name = params.name!
        const definition = await skills.get(name, viewOptions(query) as never)
        if (definition === undefined) throw new HttpError(404, 'skills/not-found', `skill "${name}" not found`)
        assertWritableSource(definition.source)
        const filePath = definition.path
        if (filePath === undefined) throw new HttpError(409, 'skills/no-file', 'runtime skills have no backing file')
        // Directory bundles are removed whole; flat .md files individually.
        const dir = path.dirname(filePath)
        if (path.basename(dir) === name) await fs.rm(dir, { recursive: true })
        else await fs.rm(filePath)
        json(res, 200, { deleted: true, name, path: filePath })
      },
    },
  ]
}
