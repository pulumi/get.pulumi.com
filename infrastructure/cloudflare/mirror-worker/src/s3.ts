import { RequestContext } from './types'
import { getObjectName } from './util'

// In order to request objects with `+` in them from S3, they need to be encoded.
function rewriteSpecialCharacters(path: string): string {
    // Rewrite '+' to '%2B' in the URL for S3
    return path.replace(/\+/g, '%2B')
  }

export function s3Fetch(url: URL, request: Request): Promise<Response> {
    const urlString = rewriteSpecialCharacters(url.toString())
    if (request.headers.has('range')) {
        console.log(`Fetching ${request.headers.get('range')} from S3 ${urlString}`)
    } else {
        console.log(`Fetching whole file from S3 ${urlString}`)
    }
    return fetch(urlString, request)
}

// export function s3Fetch(ctx: RequestContext): Promise<Response> {
//     const srcUrl = new URL(getObjectName(new URL(ctx.request.url)), ctx.env.S3_SOURCE_BUCKET)
//     return _s3Fetch(srcUrl, ctx.request)
// }
