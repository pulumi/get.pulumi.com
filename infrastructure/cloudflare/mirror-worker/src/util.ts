import { RequestContext } from "./types";

export function getObjectName(ctx: RequestContext): string {
    return new URL(ctx.request.url).pathname.slice(1);
}

function writeHeaders(object: R2Object): Headers {
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('accept-ranges', 'bytes')
    headers.set('content-length', object.size.toString())
    headers.set('last-modified', object.uploaded.toUTCString())
    return headers
}


export function buildResponseFromR2(object: R2Object | R2ObjectBody, request: Request): Response {
    const headers = writeHeaders(object)
    if (!('body' in object)) {
      return new Response(null, { headers })
    }
    if (object.range) {
      const range = ('suffix' in object.range) ?
          `bytes ${object.size - object.range.suffix}-${object.size - 1}/${object.size}` :
          `bytes ${object.range.offset ?? 0}-${object.range.length ?? object.size - 1}/${object.size}`
      headers.set('content-range', range)
      }
      const status = object.body ? (request.headers.get('range') !== null ? 206 : 200) : 304
      return new Response(object.body, {
        headers,
        status,
      })
  }
