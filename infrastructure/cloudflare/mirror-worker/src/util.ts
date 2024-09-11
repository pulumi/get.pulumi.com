import { RequestContext } from "./types";

export function getObjectName(ctx: RequestContext): string {
    return new URL(ctx.request.url).pathname.slice(1);
}
