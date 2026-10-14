import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MoodleClient } from "./moodle";
import { landingPage, messagePage, signInPage } from "./pages";
import { LoginError, signInToMoodle } from "./reichman-login";
import { harvestSyllabi } from "./syllabi";
import { buildServer, type UserProps } from "./tools";

export interface Env {
  OAUTH_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL: string; // e.g. https://runi-connector.yourname.workers.dev
  MOODLE_BASE: string; // e.g. https://moodle.runi.ac.il/2027
  SYLLABUS_URL?: string; // syllabus PDF URL prefix, SectionIDC is appended
}

const SCOPE = "courses:read";

// The sign-in page runs no JavaScript at all and loads nothing from anywhere, so nothing on
// it (including any injected content) can read the password field. It can't be framed,
// cached, or leak its URL through the Referer header.
const SIGN_IN_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

// ---------- MCP endpoint (only reached with a valid access token) ----------

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: UserProps }) {
    const props = ctx.props;
    if (!props?.moodleToken) return new Response("Missing grant", { status: 401 });

    // Stateless: a fresh server and transport per request, so no Durable Objects are needed.
    const server = buildServer(props, env.CACHE_KV);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// ---------- Sign-in page (/authorize) and everything else ----------

const LOGIN_MESSAGES: Record<LoginError["code"], string> = {
  bad_credentials: "Reichman didn't accept that username and password. Check them and try again.",
  mfa_required:
    "Reichman asked for an extra verification step (2FA), which this connector can't handle yet.",
  unexpected_page:
    "The university login page looked different than expected, so sign-in stopped. Try again later.",
  no_token: "Signed in, but Moodle didn't give app access. Try again in a minute.",
};

async function authorize(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    for (const [name, value] of Object.entries(SIGN_IN_PAGE_HEADERS)) consent.headers.set(name, value);
    return new Response(signInPage(details, consent.handle, { authQuery: new URL(request.url).search }), {
      headers: consent.headers,
    });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");

  let login;
  try {
    login = await signInToMoodle(env.MOODLE_BASE, { username, password });
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    console.warn("login failed", error.code, error.message);
    // Show the same page again with the error. The handle hasn't been used yet, so it's still valid.
    const authQuery = String(form.get("authq") ?? "");
    return reRenderWithError(request, env, handle, authQuery, LOGIN_MESSAGES[error.code], username);
  }

  const moodle = new MoodleClient(env.MOODLE_BASE, login.moodleToken);
  const site = await moodle.siteInfo();

  // Collect syllabi while we still have a signed-in session. This runs after the response
  // is sent; the password only lives in this function's memory until it finishes.
  ctx.waitUntil(
    (async () => {
      try {
        const courses = await moodle.courses(site.userid);
        const report = await harvestSyllabi(
          env.CACHE_KV,
          login.browser,
          env.MOODLE_BASE,
          courses,
          { username, password },
          env.SYLLABUS_URL || undefined,
        );
        console.log("syllabus harvest", JSON.stringify(report));
      } catch (error) {
        console.warn("syllabus harvest failed", (error as Error).message);
      }
    })(),
  );

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const props: UserProps = {
    moodleToken: login.moodleToken,
    moodleBase: env.MOODLE_BASE,
    userId: site.userid,
    fullName: site.fullname,
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: `moodle-${site.userid}`,
    metadata: {}, // grant metadata is stored unencrypted, so keep it empty; the name lives in encrypted props
    scope: approved.request.scope.length ? approved.request.scope : [SCOPE],
    props,
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

// To show the form again after a failed password we need the client's description, so we
// re-parse the original /authorize query (carried in a hidden field and re-validated here).
async function reRenderWithError(
  request: Request,
  env: Env,
  handle: string,
  authQuery: string,
  message: string,
  username: string,
): Promise<Response> {
  if (authQuery.startsWith("?")) {
    try {
      const original = new Request(new URL("/authorize" + authQuery, request.url).toString());
      const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(original);
      const details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
      return new Response(signInPage(details, handle, { error: message, username, authQuery }), {
        status: 401,
        headers: SIGN_IN_PAGE_HEADERS,
      });
    } catch {
      // fall through to the generic message
    }
  }
  return messagePage("Sign-in failed", `${message} Go back to your AI app and connect again.`, 401);
}

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") {
      try {
        return await authorize(request, env, ctx);
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo) {
          return Response.redirect(error.redirectTo, 302);
        }
        if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
          const message =
            error instanceof AuthorizationError
              ? error.description ?? "This sign-in link is invalid or expired."
              : "The app asking for access could not be verified.";
          return messagePage("Can't continue", `${message} Go back to your AI app and connect again.`);
        }
        throw error;
      }
    }
    if (url.pathname === "/") return landingPage(env.PUBLIC_URL);
    return new Response("Not found", { status: 404 });
  },
};

// The provider needs the public URL, which comes from an env var, so build it lazily.
let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    provider ??= new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE, "offline_access"],
      resourceMetadata: {
        resource: `${env.PUBLIC_URL}/mcp`,
        authorization_servers: [env.PUBLIC_URL],
        resource_name: "Reichman courses (unofficial)",
      },
      accessTokenTTL: 60 * 60, // 1 hour; apps refresh silently
      refreshTokenTTL: 60 * 60 * 24 * 180, // a semester-ish; Moodle token expiry may come first
    });
    return provider.fetch(request, env, ctx);
  },
};
