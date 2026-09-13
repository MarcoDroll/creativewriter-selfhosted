import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'

// EdgeRuntime is injected by the Supabase self-hosted edge runtime at execution
// time (it is not a Deno global), so declare it for the type-checker only — no
// runtime effect. Typed to just the surface this router uses.
declare const EdgeRuntime: {
  userWorkers: {
    create(opts: Record<string, unknown>): Promise<{ fetch(req: Request): Promise<Response> }>
  }
}

console.log('main function started')

/**
 * Read at CALL time, never captured at module scope.
 *
 * This gate is dormant today — `docker-compose.yml` hardcodes `VERIFY_JWT: "false"`, so
 * the per-function `extractAuthFromRequest` is what actually authenticates. But it is the
 * same shape as the defect just removed from `_shared/auth.ts`: a secret captured once
 * lives as long as the isolate, which made rotating `JWT_SECRET` a silent no-op — new
 * tokens rejected, leaked ones still accepted. Captured at module scope it would be worse
 * than what was there, since the env would not even be re-read. Fixed while dormant so
 * enabling the flag one day cannot quietly reintroduce it.
 */
const verifyJwtEnabled = () => Deno.env.get('VERIFY_JWT') === 'true'

function getAuthToken(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    throw new Error('Missing authorization header')
  }
  const [bearer, token] = authHeader.split(' ')
  if (bearer !== 'Bearer') {
    throw new Error(`Auth header is not 'Bearer {token}'`)
  }
  return token
}

async function verifyJWT(jwt: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const secretKey = encoder.encode(Deno.env.get('JWT_SECRET'))
  try {
    await jose.jwtVerify(jwt, secretKey)
  } catch (err) {
    console.error(err)
    return false
  }
  return true
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && verifyJwtEnabled()) {
    try {
      const token = getAuthToken(req)
      const isValidJWT = await verifyJWT(token)

      if (!isValidJWT) {
        return new Response(JSON.stringify({ msg: 'Invalid JWT' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    } catch (e) {
      console.error(e)
      return new Response(JSON.stringify({ msg: String(e) }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  const url = new URL(req.url)
  const { pathname } = url
  const path_parts = pathname.split('/')
  const service_name = path_parts[1]

  if (!service_name || service_name === '') {
    const error = { msg: 'missing function name in request' }
    return new Response(JSON.stringify(error), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const servicePath = `/home/deno/functions/${service_name}`
  console.error(`serving the request with ${servicePath}`)

  // Match hosted Supabase free-tier user-worker limits so Deep Writer phases
  // get the same wall-clock budget on self-hosted as they do hosted.
  const memoryLimitMb = 256
  const workerTimeoutMs = 150_000
  const noModuleCache = Deno.env.get('NO_MODULE_CACHE') === 'true'
  const forceCreate = false
  const importMapPath = null
  const cpuTimeSoftLimitMs = 150_000
  const cpuTimeHardLimitMs = 150_000
  const envVarsObj = Deno.env.toObject()
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]])

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      forceCreate,
      importMapPath,
      cpuTimeSoftLimitMs,
      cpuTimeHardLimitMs,
      envVars,
    })
    return await worker.fetch(req)
  } catch (e) {
    const error = { msg: String(e) }
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
