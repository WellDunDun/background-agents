import type { FactoryEnv } from "./env.js";

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_USER_AGENT = "flue-factory";
export const GITHUB_FETCH_TIMEOUT_MS = 60000;

const TOKEN_CACHE_MAX_AGE_MS = 50 * 60 * 1000;
const TOKEN_MIN_REMAINING_MS = 5 * 60 * 1000;
const installationTokenCache = new Map<string, CachedInstallationToken>();
const installationTokenRefreshInFlight = new Map<string, Promise<CachedInstallationToken>>();
const importedPrivateKeyCache = new Map<string, Promise<CryptoKey>>();

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface InstallationRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  language?: string | null;
  topics?: string[];
}

export interface PullRequestResult {
  number: number;
  webUrl: string;
  apiUrl: string;
  state: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
}

interface CachedInstallationToken {
  token: string;
  expiresAtEpochMs: number;
  cachedAtEpochMs: number;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

export function getGitHubAppConfig(env: FactoryEnv): GitHubAppConfig {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID are required.",
    );
  }

  return {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
  };
}

export async function getCachedInstallationToken(
  config: GitHubAppConfig,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  const cached = await getOrRefreshCachedInstallationToken(config, options?.forceRefresh ?? false);
  return cached.token;
}

export async function getInstallationRepository(
  config: GitHubAppConfig,
  owner: string,
  repo: string,
): Promise<InstallationRepository | null> {
  let forceRefresh = false;
  let response: Response | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getCachedInstallationToken(config, { forceRefresh });
    response = await githubFetch(GITHUB_API_BASE + "/repos/" + owner + "/" + repo, token);

    if (response.status !== 401) {
      break;
    }

    invalidateInstallationTokenCache(config);
    forceRefresh = true;
  }

  if (!response) {
    throw new Error("Failed to fetch repository.");
  }

  if (response.status === 403 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Failed to fetch repository: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as {
    id: number;
    name: string;
    full_name: string;
    description: string | null;
    private: boolean;
    default_branch: string;
    language?: string | null;
    topics?: string[];
    owner: { login: string };
  };

  return {
    id: data.id,
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    description: data.description,
    private: data.private,
    defaultBranch: data.default_branch,
    language: data.language,
    topics: data.topics,
  };
}

export async function listInstallationRepositories(
  config: GitHubAppConfig,
): Promise<InstallationRepository[]> {
  const token = await getCachedInstallationToken(config);
  const repos: InstallationRepository[] = [];
  let page = 1;

  while (page <= 20) {
    const response = await githubFetch(
      GITHUB_API_BASE + "/installation/repositories?per_page=100&page=" + page,
      token,
    );
    if (!response.ok) {
      throw new Error("Failed to list installation repositories: " + response.status + " " + (await response.text()));
    }

    const data = (await response.json()) as {
      repositories: Array<{
        id: number;
        name: string;
        full_name: string;
        description: string | null;
        private: boolean;
        default_branch: string;
        language?: string | null;
        topics?: string[];
        owner: { login: string };
      }>;
    };

    repos.push(
      ...data.repositories.map((repo) => ({
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        defaultBranch: repo.default_branch,
        language: repo.language,
        topics: repo.topics,
      })),
    );

    if (data.repositories.length < 100) {
      break;
    }
    page++;
  }

  return repos;
}

export async function createPullRequest(
  config: GitHubAppConfig,
  input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    sourceBranch: string;
    targetBranch: string;
    draft?: boolean;
  },
): Promise<PullRequestResult> {
  const token = await getCachedInstallationToken(config);
  const response = await githubFetch(GITHUB_API_BASE + "/repos/" + input.owner + "/" + input.repo + "/pulls", token, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.sourceBranch,
      base: input.targetBranch,
      draft: input.draft ?? true,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to create pull request: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as {
    number: number;
    html_url: string;
    url: string;
    state: string;
    draft: boolean;
    head: { ref: string };
    base: { ref: string };
  };

  return {
    number: data.number,
    webUrl: data.html_url,
    apiUrl: data.url,
    state: data.state,
    draft: data.draft,
    sourceBranch: data.head.ref,
    targetBranch: data.base.ref,
  };
}

export async function commentOnIssue(
  config: GitHubAppConfig,
  input: { owner: string; repo: string; issueNumber: number; body: string },
): Promise<void> {
  const token = await getCachedInstallationToken(config);
  const response = await githubFetch(
    GITHUB_API_BASE + "/repos/" + input.owner + "/" + input.repo + "/issues/" + input.issueNumber + "/comments",
    token,
    {
      method: "POST",
      body: JSON.stringify({ body: input.body }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to comment on issue: " + response.status + " " + (await response.text()));
  }
}

export function parseRepositorySlug(repo: string): { owner: string; name: string } {
  const [owner, name, ...extra] = repo.split("/");
  if (!owner || !name || extra.length > 0) {
    throw new Error("Repository must be in owner/name form.");
  }
  return { owner, name };
}

async function getOrRefreshCachedInstallationToken(
  config: GitHubAppConfig,
  forceRefresh = false,
): Promise<CachedInstallationToken> {
  const cacheKey = getInstallationTokenCacheKey(config);
  if (!forceRefresh) {
    const cached = installationTokenCache.get(cacheKey);
    if (cached && isTokenUsable(cached)) {
      return cached;
    }

    const inFlight = installationTokenRefreshInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
  }

  const refresh = refreshInstallationToken(config).finally(() => {
    installationTokenRefreshInFlight.delete(cacheKey);
  });
  installationTokenRefreshInFlight.set(cacheKey, refresh);
  return refresh;
}

async function refreshInstallationToken(config: GitHubAppConfig): Promise<CachedInstallationToken> {
  const nowEpochMs = Date.now();
  const jwt = await generateAppJwt(config.appId, config.privateKey);
  const response = await fetchWithTimeout(
    GITHUB_API_BASE + "/app/installations/" + config.installationId + "/access_tokens",
    {
      method: "POST",
      headers: githubHeaders("Bearer " + jwt),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to get installation token: " + response.status + " " + (await response.text()));
  }

  const data = (await response.json()) as InstallationTokenResponse;
  const parsedExpiresAtEpochMs = Date.parse(data.expires_at);
  const cached = {
    token: data.token,
    expiresAtEpochMs: Number.isFinite(parsedExpiresAtEpochMs)
      ? parsedExpiresAtEpochMs
      : nowEpochMs + TOKEN_CACHE_MAX_AGE_MS,
    cachedAtEpochMs: nowEpochMs,
  };

  installationTokenCache.set(getInstallationTokenCacheKey(config), cached);
  return cached;
}

async function generateAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    }),
  );
  const signingInput = encodedHeader + "." + encodedPayload;
  const key = await importPrivateKeyCached(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return signingInput + "." + base64UrlEncode(new Uint8Array(signature));
}

async function githubFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...githubHeaders("Bearer " + token),
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": GITHUB_USER_AGENT,
  };
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function getInstallationTokenCacheKey(config: GitHubAppConfig): string {
  return config.appId + ":" + config.installationId;
}

function invalidateInstallationTokenCache(config: GitHubAppConfig): void {
  const cacheKey = getInstallationTokenCacheKey(config);
  installationTokenCache.delete(cacheKey);
  installationTokenRefreshInFlight.delete(cacheKey);
}

function isTokenUsable(cached: CachedInstallationToken, nowEpochMs = Date.now()): boolean {
  const cacheAgeMs = nowEpochMs - cached.cachedAtEpochMs;
  return cacheAgeMs < TOKEN_CACHE_MAX_AGE_MS && nowEpochMs < cached.expiresAtEpochMs - TOKEN_MIN_REMAINING_MS;
}

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parsePemPrivateKey(pem: string): Uint8Array {
  const normalizedPem = pem.replace(/\\n/g, "\n");
  const pemContents = normalizedPem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(pemContents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importPrivateKeyCached(pem: string): Promise<CryptoKey> {
  const cached = importedPrivateKeyCache.get(pem);
  if (cached) {
    return cached;
  }
  const imported = crypto.subtle
    .importKey(
      "pkcs8",
      parsePemPrivateKey(pem).buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )
    .catch((error) => {
      importedPrivateKeyCache.delete(pem);
      throw new Error(
        "Unable to import GitHub private key. Convert it to PKCS#8 with openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt. Original error: " +
          String(error),
      );
    });
  importedPrivateKeyCache.set(pem, imported);
  return imported;
}
