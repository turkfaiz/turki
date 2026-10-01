import { anyAiKey } from "../aiProviders.js";

export function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** هوية المراجع كما وصلت فعلًا، ولا تُنسب القرارات إلى مجهول بصمت. */
export function reviewerOf(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const user = atob(header.slice(6)).split(":")[0];
      if (user) return user;
    } catch {
      /* fall through to the configured identity */
    }
  }
  return env.DASHBOARD_USER || "unauthenticated-local";
}

export function authorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return !anyAiKey(env);
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const user = env.DASHBOARD_USER || "mayorwatch";
    return decoded === `${user}:${env.DASHBOARD_PASSWORD}`;
  } catch {
    return false;
  }
}

export function authRequired() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="MayorWatch"',
      "Cache-Control": "no-store",
    },
  });
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
