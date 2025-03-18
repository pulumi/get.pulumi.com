import { RequestContext } from './types'
import { getObjectName, buildResponseFromR2 } from './util'

// This is the chunk size that aws libraries use by default for multipart uploads
const CHUNK_ALIGNMENT = 8 * 1024 * 1024; // 8MB
// https://developers.cloudflare.com/r2/objects/multipart-objects/#limitations
const MIN_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CHUNK_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
// Workers are only allowed 6 active connections
const MAX_PARTS = 5;

interface ObjectPart {
    partNumber: number;
    range: string;
    srcUrl: URL;
    uploadId: R2MultipartUpload;
  }

/**
 * A wrapper around fetch() that deals with S3's URL idiosyncrasies.
 * @param url The URL of the object in S3.
 * @param request Request settings to use.
 * @returns A promise that resolves to the response from S3.
 */
export async function s3Fetch(url: URL, oldRequest: Request): Promise<Response> {
    // We need to encode `+` to `%2B` in order to properly fetch such URLS from S3
    const urlString = url.toString().replace(/\+/g, '%2B')
    // Don't try to get S3 to compress small checksum files
    const headers = new Headers(oldRequest.headers)
    headers.delete('Accept-Encoding')
    const request = new Request(oldRequest, { cf: { }, headers } )
    if (request.headers.has('range')) {
        console.log(`[S3] ${request.method} ${request.headers.get('range')} ${urlString}`)
    } else {
        console.log(`[S3] ${request.method} ${urlString}`)
    }
    return fetch(urlString, request)
}

/**
 * Fetches the headers of an object from a S3 URL.
 * @param url The URL of the object in S3.
 * @param request Request settings to use.
 * @returns A promise that resolves to the response from S3.
 */
export async function s3FetchHead(url: URL, request: Request): Promise<Response> {
    return s3Fetch(url, new Request(request, { method: 'HEAD' }))
}

/**
 * Reads an object from a S3 URL while simultaneously copying it to R2.
 *
 * @param ctx The request context.
 * @param srcUrl The URL of the object in S3.
 * @param s3Info The Response from a HEAD request for the object.
 * @returns A promise that resolves to the requested object data.
 */
export async function s3CopyRead(ctx: RequestContext, srcUrl: URL): Promise<Response> {
    // If we're only fetching a part of the file, just return the response from S3
    if (ctx.request.headers.has('range')) {
        // However, start pulling the object into R2 in the background
        // We only do this on the first chunk, as there's likely to be a lot of simultaneous requests
        if (ctx.request.headers.get('range')?.match(/bytes=0-/)) {
            const newHeaders = new Headers(ctx.request.headers)
            newHeaders.delete('range')
            const fullRequest = new Request(ctx.request, { headers: newHeaders })
            const fullInfo = await s3FetchHead(srcUrl, fullRequest)
            ctx.execution.waitUntil(copyToR2({...ctx, request: fullRequest}, srcUrl, fullInfo))
        }
        return s3Fetch(srcUrl, ctx.request)
    }
    console.log(`Copying ${getObjectName(ctx)} from S3 to R2`);
    const s3Info = await s3FetchHead(srcUrl, ctx.request)
    const fileSize = Number(s3Info.headers.get('content-length'))
    if (fileSize <= CHUNK_ALIGNMENT) {
        return simpleCopyRead(ctx, srcUrl);
    } else {
        return multiPartCopyRead(ctx, srcUrl, s3Info);
    }
}

/**
 * Reads an object from a S3 URL and simultaneously copies it to R2 in a single chunk.
 *
 * @param ctx The request context.
 * @param srcUrl The URL of the object in S3.
 * @returns A promise that resolves to the response from S3.
 */
async function simpleCopyRead(ctx: RequestContext, srcUrl: URL): Promise<Response> {
    const objectName = getObjectName(ctx)
    const s3Response = await s3Fetch(srcUrl, ctx.request)
    if (s3Response.status !== 200 || s3Response.body === null) {
        return s3Response;
    }
    console.log(`Putting ${objectName} in R2`)
    const s3Body = s3Response.body.tee()
    ctx.execution.waitUntil(ctx.env.LINKED_R2_BUCKET.put(
        objectName, s3Body[0], { httpMetadata: s3Response.headers }
    ));
    return new Response(s3Body[1], s3Response)
}

/**
 * Copies a part of a file from S3 to R2 as part of an existing multiPart upload.
 * @param ctx The request context.
 * @param part Information about the part to copy.
 * @returns A promise that resolves to the uploaded part in R2.
 */
async function copyPart(ctx: RequestContext, part: ObjectPart): Promise<R2UploadedPart> {
    const response = await s3Fetch(part.srcUrl, new Request(ctx.request, { headers: {'range': part.range }}))
    if (response.status !== 206 || response.body === null) {
        throw new Error(`Failed to fetch part ${part.partNumber} for ${getObjectName(ctx)}: ${response.status}`)
    }
    return part.uploadId.uploadPart(part.partNumber, response.body)
}

/**
 * Calculates the part size for multi-part copy based on the file size, part count, and chunk alignment.
 *
 * @param fileSize The total size of the file.
 * @param maxParts The max number of parts we want to split across.
 * @param chunkAlignment The chunk size to align part boundaries to.
 * @returns The calculated part size.
 */
function calculatePartSize(fileSize: number, maxParts: number, chunkAlignment: number): number {
    const numChunks = Math.ceil(fileSize / chunkAlignment)
    const chunkSize = Math.ceil(numChunks / maxParts) * chunkAlignment
    return Math.min(Math.max(chunkSize, MIN_CHUNK_SIZE), MAX_CHUNK_SIZE)
}

/**
 * Copies an object from S3 to R2 using multiple simultaneous requests if necessary.
 *
 * @param ctx The request context.
 * @param srcUrl The URL of the object in S3.
 * @param s3Info The response from a HEAD of the object in S3.
 * @returns A promise that resolves to the new object in R2.
 */
async function copyToR2(ctx: RequestContext, srcUrl: URL, s3Info: Response): Promise<R2Object> {
    const fileSize = Number(s3Info.headers.get('content-length'))
    const objectName = getObjectName(ctx)
    // Skip doing multi-part copy if the file is small enough
    if (fileSize <= MIN_CHUNK_SIZE) {
        console.log(`Putting ${objectName} in R2`)
        const s3Response = await s3Fetch(srcUrl, ctx.request)
        return ctx.env.LINKED_R2_BUCKET.put(
            getObjectName(ctx), s3Response.body, { httpMetadata: s3Response.headers }
        )
    }
    const partSize = calculatePartSize(fileSize, MAX_PARTS, CHUNK_ALIGNMENT)
    const partCount = Math.ceil(fileSize / partSize)
    console.log(`Putting ${objectName} into R2 with ${partCount} different ${partSize} byte parts`)
    // Open the multipart upload
    const uploadId = await ctx.env.LINKED_R2_BUCKET.createMultipartUpload(
        objectName, { httpMetadata: s3Info.headers }
    )
    try {
        // Start copying the parts
        const parts = []
        for (let i = 0; i < partCount; i++) {
            const partNumber = i + 1
            const range = `bytes=${i * partSize}-${Math.min((i + 1) * partSize - 1, fileSize - 1)}`
            parts.push(copyPart(ctx, { uploadId, partNumber, range, srcUrl }))
        }
        // Finalize after all parts are copied
        return uploadId.complete(await Promise.all(parts))
    } catch (error) {
        console.error(`Failed to copy ${objectName} from S3 to R2`)
        if (error instanceof Error) {
            console.error("Error message:", error.message)
            console.error("Stack trace:", error.stack)
        }
        uploadId.abort()
        throw error
    }
}

/**
 * Performs a multi-part copy of an object from S3 to R2 using multiple simultaneous requests.
 * before returning the newly copied object from R2.
 *
 * @param ctx The request context.
 * @param srcUrl The URL of the object in S3.
 * @param s3Info The response from S3.
 * @returns A promise that resolves to the response from R2.
 */
async function multiPartCopyRead(ctx: RequestContext, srcUrl: URL, s3Info: Response): Promise<Response> {
    const objectName = getObjectName(ctx)
    console.log(`Multipart copying ${objectName} from S3 to R2`)
    try {
        const newObject = await copyToR2(ctx, srcUrl, s3Info)
        const newObjectBody = await ctx.env.LINKED_R2_BUCKET.get(newObject.key)
        if (newObjectBody) {
            return buildResponseFromR2(newObjectBody, ctx.request)
        }
        // If something has gone wrong, just try to send the data straight from S3
        console.error(`Failed to retrieve ${objectName} from R2 after upload`)
        return s3Fetch(srcUrl, ctx.request)
    } catch {
        return s3Fetch(srcUrl, ctx.request)
    }
}
