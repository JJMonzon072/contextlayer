import { describe, expect, it, vi } from 'vitest'

import { ApiUnreachableError, createApiClient } from '../src/background/api-client'

function client(response: () => Promise<Response> = () => Promise.resolve(new Response(null))) {
  const fetchImpl = vi.fn<typeof fetch>(response)
  return { api: createApiClient('https://api.example.com', fetchImpl), fetchImpl }
}

describe('createApiClient', () => {
  it('sends the bearer token to the API origin only, without cookies or redirects', async () => {
    const { api, fetchImpl } = client()

    await api.request('/v1/extension/session', { bearer: 'cla_token' })

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toEqual(new URL('https://api.example.com/v1/extension/session'))
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' })
    expect(init?.headers).toMatchObject({ authorization: 'Bearer cla_token' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses paths that would leave the API origin', async () => {
    const { api, fetchImpl } = client()

    for (const path of ['//evil.example/steal', 'https://evil.example/', 'v1/relative']) {
      await expect(api.request(path, { bearer: 'cla_token' })).rejects.toBeInstanceOf(
        ApiUnreachableError,
      )
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('turns network failures into ApiUnreachableError', async () => {
    const { api } = client(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(api.request('/health')).rejects.toBeInstanceOf(ApiUnreachableError)
  })
})
